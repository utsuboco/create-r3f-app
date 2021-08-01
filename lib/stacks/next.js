'use strict';

const fs = require('fs-extra');
const sysPath = require('path');
const chalk = require('chalk');
const hostedGitInfo = require('hosted-git-info');
const execa = require('execa');
const commandExists = require('command-exists');

const initGit = require('../utils/init-git');
const messages = require('../utils/messages');
const getInstallCmd = require('../utils/get-install-cmd');
const output = require('../utils/output');

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
          await execa(installCmd, [installDepsCmd, '-D', 'styled-components', 'babel-plugin-styled-components']);
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

const initForTypeScript = async (root) => {
  output.info('Initializing for TypeScript...');

  const jsConfigJson = await fs.readFile(sysPath.join(root, 'jsconfig.json'))
    .then((value) => {
      const lines = value.toString().split('\n');
      const filtered = lines.filter(line => !line.match(/@js-ignore/));
      return JSON.parse(filtered.join(''));
    });
  const compilerOptions = jsConfigJson.compilerOptions;
  const { module, ...others } = compilerOptions;
  const tsConfigBaseJson = {
    compilerOptions: others
  };
  await fs.writeJson(sysPath.join(root, 'tsconfig.json'), tsConfigBaseJson, { spaces: 2 });
  await fs.remove(sysPath.join(root, 'jsconfig.json'));
  await fs.remove(sysPath.join(root, 'jsconfig.server.json'));

  const installCmd = getInstallCmd();
  const useYarn = installCmd === 'yarn';
  const buildCmd = useYarn ? ['build'] : ['run', 'build'];

  await execa(installCmd, buildCmd);
  output.success('Succeed to initialize for TypeScript');
}

const initForStyledComponents = async (root) => {
  output.info('Initializing for styled-components...');

  const installCmd = getInstallCmd();
  const useYarn = installCmd === 'yarn';
  const uninstallCmd = useYarn ? ['remove'] : ['uninstall'];

  await execa(installCmd, [...uninstallCmd, 'tailwindcss']);

  await fs.remove(sysPath.join(root, 'postcss.config.js'));
  await fs.remove(sysPath.join(root, 'tailwind.config.js'));

  const babelrc = await fs.readJSON(sysPath.join(root, '.babelrc'));
  babelrc.plugins.push('styled-components');
  await fs.writeJSON(sysPath.join(root, '.babelrc'), babelrc, { spaces: 2 });

  const eslintrc = await fs.readJSON(sysPath.join(root, '.eslintrc'));
  const newEslintRcExtends = eslintrc.extends.filter(extend => extend !== 'plugin:tailwind/recommended');
  await fs.writeJSON(sysPath.join(root, '.eslintrc'), { extends: newEslintRcExtends }, { spaces: 2 });

  const indexCss = await fs.readFile(sysPath.join(__dirname, '../styles/index.css'));
  await fs.writeFile(sysPath.join(root, 'src/styles/index.css'), indexCss);

  output.success('Succeed to initialize for styled-components');
}

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
  } else {
    const indexCss = await fs.readFile(sysPath.join(__dirname, '../styles/index.tailwind.css'));
    await fs.writeFile(sysPath.join(root, 'src/styles/index.css'), indexCss);
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
