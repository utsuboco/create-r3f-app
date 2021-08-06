'use strict';

const fs = require('fs-extra');
const sysPath = require('path');
const chalk = require('chalk');
const hostedGitInfo = require('hosted-git-info');
const execa = require('execa');
const commandExists = require('command-exists');
const postcss = require('postcss');
const importFrom = require('import-from');
const j = require('jscodeshift');

const initGit = require('../utils/init-git');
const messages = require('../utils/messages');
const getInstallCmd = require('../utils/get-install-cmd');
const output = require('../utils/output');
const extractClassNames = require('../utils/extract-class-names');

const install = async (projectName, typescript, isNotDefaultStyle) => {
  const installCmd = getInstallCmd();

  output.info('Installing packages...');
  process.chdir(projectName);

  return new Promise((resolve, reject) => {
    commandExists(installCmd)
      .then(() => execa(installCmd, ['install']))
      .then(() => output.success(`Installed dependencies for ${output.cmd(projectName)}`))
      .then(async () => {
        const useYarn = installCmd === 'yarn';
        const installDepsCmd = useYarn ? 'add' : 'install'

        if (isNotDefaultStyle) {
          output.info('Installing packages for styled-components...');
          await execa(installCmd, [installDepsCmd, 'styled-components', 'react-is']);
          await execa(installCmd, [installDepsCmd, '-D', 'babel-plugin-styled-components']);

          if (typescript) await execa(installCmd, [installDepsCmd, '-D', '@types/styled-components']);
          output.success('Installed dependencies for styled-components');
        }

        if (typescript) {
          output.info('Installing packages for TypeScript...');
          await execa(installCmd, [installDepsCmd, '-D', 'typescript', '@types/react', '@types/node']);
          output.success('Installed dependencies for TypeScript');
        }
        
        resolve();
      })
      .catch(() => reject(new Error(`${installCmd} installation failed`)));
  }).catch((error) => output.error(error.message));
};

const recursiveReaddir = async (root, dir, files = []) => {
  const srcDirs = [];
  const srcDirents = await fs.readdir(sysPath.join(root, dir), { withFileTypes: true });

  srcDirents.forEach((dirent) => {
    if (dirent.isDirectory()) srcDirs.push(`${dir}/${dirent.name}`);
    if (dirent.isFile()) files.push(`${dir}/${dirent.name}`);
  });

  for (const srcDir of srcDirs) {
    files = await recursiveReaddir(root, srcDir, files);
  }

  return Promise.resolve(files);
}

const initForTypeScript = async (root) => {
  output.info('Initializing for TypeScript...');

  const jsConfigJson = await fs.readFile(sysPath.join(root, 'jsconfig.json'))
    .then((value) => {
      const lines = value.toString().split('\n');
      const filtered = lines.filter(line => !line.match(/@js-ignore/));
      return JSON.parse(filtered.join(''));
    });
  const compilerOptions = jsConfigJson.compilerOptions;
  const { module, ...otherOptions } = compilerOptions;
  const tsConfigBaseJson = {
    compilerOptions: otherOptions
  };
  await fs.writeJson(sysPath.join(root, 'tsconfig.json'), tsConfigBaseJson, { spaces: 2 });
  await fs.remove(sysPath.join(root, 'jsconfig.json'));
  await fs.remove(sysPath.join(root, 'jsconfig.server.json'));

  const packageJson = await fs.readJSON(sysPath.join(root, 'package.json'));
  const { scripts, ...otherConfigs } = packageJson;
  scripts.prettier = 'prettier --list-different \"./src/**/*.{ts,tsx,md}\"';
  const newPackageJson = { ...otherConfigs, scripts };
  await fs.writeJSON(sysPath.join(root, 'package.json'), newPackageJson, { spaces: 2 });

  const installCmd = getInstallCmd();
  const useYarn = installCmd === 'yarn';
  const buildCmd = useYarn ? ['build'] : ['run', 'build'];

  await execa(installCmd, buildCmd);
  output.success('Succeed to initialize for TypeScript');
}

const compilePostCss = (str, root) => {
  const tailwindcss = importFrom(root, 'tailwindcss');
  return postcss([tailwindcss(sysPath.join(root, 'tailwind.config.js'))])
    .process(str, {
      from: undefined,
      to: undefined,
      map: false
    });
}

const migrateTailwindToStyled = async (root) => {
  const indexTailwindCss = await fs.readFile(sysPath.join(root, 'src/styles/index.css'));
  const compiled = await compilePostCss(indexTailwindCss.toString(), root);
  const baseCss = await compilePostCss('@tailwind base;', root).css;

  const extracted = await extractClassNames(compiled.root);
  const srcAllFiles = await recursiveReaddir(root, 'src');
  const srcJsxFiles = srcAllFiles.filter(file => new RegExp(/.jsx/).test(file));
  const targetJsxFiles = srcJsxFiles.filter(file => {
    const parsed = sysPath.parse(file);
    const fileName = parsed.name;
    if (fileName === 'dom' || fileName === 'Instructions') return file;
  });

  const elements = [];
  const components = [];
  const isClassName = (value) => value.name?.name === 'className';
  for (const targetJsxFile of targetJsxFiles) {
    const targetFilePath = sysPath.join(root, targetJsxFile);
    const source = await fs.readFile(targetFilePath);
    const ast = j(source.toString());
    ast
      .find(j.JSXElement)
      .find(j.JSXOpeningElement)
      .forEach((path) => {
        if (path.value.attributes?.some(attr => isClassName(attr))) {
          elements.push({
            fileName: targetJsxFile,
            name: path.value?.name?.name,
            startPos: path.value?.loc.start,
          })
        }
      })
      .find(j.JSXAttribute, (value) => isClassName(value))
      .find(j.Literal)
      .forEach((path, index) => {
        let cssValuesStr = '';
        const value = path.value?.value;
        if (value && components.every(component => component?.classNames !== value)) {
          const classNameList = value.split(' ');
          classNameList.forEach((name) => {
            if (extracted.classNames[`${name}`]?.__info) {
              const { __rule, __source, __pseudo, __scope, __context, ...values } = extracted.classNames[`${name}`].__info;
              const entries = `${Object.entries(values).map(value => `${value.join(': ')}`).join(';\n')};`;
              const cssStr = __context.length > 0
                ? `${__context} {\n ${entries}\n}`
                : entries;
              cssValuesStr += `  ${cssStr}\n`;
            }
          });
          const componentName = `Component${index + 1}`;
          components.push({
            id: index,
            name: componentName,
            fileName: targetJsxFile,
            classNames: value,
            body: `const ${componentName} = styled.${elements[index].name}\`\n${cssValuesStr}\`\n`,
          });
        }
      });
    
    const newSource = ast
      .find(j.JSXElement, (value) => value.openingElement?.attributes.some(v => isClassName(v)))
      .replaceWith((path) => {
        const attrs = path.value.openingElement?.attributes;
        if (attrs && attrs.some(attr => isClassName(attr))) {
          const literal = attrs.find(attr => attr?.value.type === 'Literal');
          const identifier = components.find(component => component.classNames === literal?.value.value).name;
          const children = path.value?.children;
          const filterdAttrs = attrs.filter(attr => !isClassName(attr));
          return j.jsxElement(
            j.jsxOpeningElement(j.jsxIdentifier(identifier), filterdAttrs),
            j.jsxClosingElement(j.jsxIdentifier(identifier)), children
          );
        }
      })
      .toSource({ lineTerminator: '\n' });

    await fs.writeFile(targetFilePath, newSource);
  }

  const prettier = importFrom(root, 'prettier');
  const prettierOptions = await prettier.resolveConfig(sysPath.join(root, '.prettierrc'));

  for (const component of components) {
    let source = await fs.readFile(sysPath.join(root, component.fileName));
    if (component.id < 1) source = `import styled from 'styled-components'\n\n` + source;
    source += `\n${component.body}`;

    const formatted = prettier.format(source, { ...prettierOptions, parser: 'babel' });
    await fs.writeFile(sysPath.join(root, component.fileName), formatted);
  }

  await fs.writeFile(sysPath.join(root, 'src/styles/index.css'), baseCss);
}

const initForStyledComponents = async (root) => {
  output.info('Initializing for styled-components...');

  const installCmd = getInstallCmd();
  const useYarn = installCmd === 'yarn';
  const uninstallCmd = useYarn ? 'remove' : 'uninstall';

  await migrateTailwindToStyled(root);

  await execa(installCmd, [uninstallCmd, 'tailwindcss']);

  await fs.remove(sysPath.join(root, 'postcss.config.js'));
  await fs.remove(sysPath.join(root, 'tailwind.config.js'));

  const babelrc = await fs.readJSON(sysPath.join(root, '.babelrc'));
  babelrc.plugins.push('styled-components');
  await fs.writeJSON(sysPath.join(root, '.babelrc'), babelrc, { spaces: 2 });

  const eslintrc = await fs.readJSON(sysPath.join(root, '.eslintrc'));
  const newEslintRcExtends = eslintrc.extends.filter(extend => extend !== 'plugin:tailwind/recommended');
  await fs.writeJSON(sysPath.join(root, '.eslintrc'), { extends: newEslintRcExtends }, { spaces: 2 });

  // Need to lower the version of react to get styled-components to work well...
  const downgradeReactCmd = useYarn ? ['upgrade', 'react@^17.0.2'] : ['install', 'react@17.0.2'];
  await execa(installCmd, [...downgradeReactCmd]);

  output.success('Succeed to initialize for styled-components');
}

async function next(projectName, projectPath, projectStyle, projectOption) {
  output.info(
    `🚀 Creating ${chalk.bold(chalk.green(projectName))} using ${chalk.bold(
      'r3f-next-starter',
    )}...`,
  );

  const isNotDefaultStyle = projectStyle !== 'tailwind';
  const isPmndrs = isNotDefaultStyle && projectStyle !== 'styled';
  const hostedInfo = hostedGitInfo.fromUrl('https://github.com/pmndrs/react-three-next');
  const url = hostedInfo.https({ noCommittish: !isPmndrs, noGitPlus: true });
  const branch = isPmndrs ? ['--branch', 'pmndrs'] : ['--branch', 'main'];
  const recursive = isPmndrs ? [] : ['--recursive'];
  const args = [
    'clone',
    url,
    ...branch,
    projectName,
    '--single-branch',
    ...recursive,
  ].filter((arg) => Boolean(arg));
  await execa('git', args, { stdio: 'inherit' });

  output.success(`Folder and files created for ${output.cmd(projectName)}`);

  await fs.remove(sysPath.join(projectName, '.git'));

  const root = sysPath.resolve(projectName);

  const typescript = projectOption === 'typescript';

  await install(projectName, typescript, isNotDefaultStyle);
  process.chdir(projectPath);

  if (isNotDefaultStyle) {
    await initForStyledComponents(root);
  }

  if (typescript) {
    await initForTypeScript(root);

    const srcAllFiles = await recursiveReaddir(root, 'src');
    const srcJsFiles = srcAllFiles.filter(file => new RegExp(/.js|jsx/).test(file));

    for (const srcJsFile of srcJsFiles) {
      const parsed = sysPath.parse(srcJsFile);
      const newExt = parsed.ext === '.js' ? '.ts' : '.tsx';
      await fs.rename(sysPath.join(root, srcJsFile), sysPath.join(root, `${parsed.dir}/${parsed.name}${newExt}`));
    }
  }

  await initGit('Next');
  messages.start(projectName, 'next');
}

module.exports = next;
