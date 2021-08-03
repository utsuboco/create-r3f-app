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

const install = async (projectName, typescript) => {
  const installCmd = getInstallCmd();

  output.info('Installing packages...');
  process.chdir(projectName);

  return new Promise((resolve, reject) => {
    commandExists(installCmd)
      .then(() => execa(installCmd, ['install']))
      .then(() => output.success(`Installed dependencies for ${output.cmd(projectName)}`))
      .then(async () => {
        if (typescript) {
          const useYarn = installCmd === 'yarn';
          output.info('Installing packages for TypeScript...');
          const installDepsCmd = useYarn ? 'add' : 'install'
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
  const { module, ...otherOptions } = compilerOptions;
  const tsConfigBaseJson = {
    compilerOptions: otherOptions
  };
  await fs.writeJson(sysPath.join(root, 'tsconfig.json'), tsConfigBaseJson, { spaces: 2 });
  await fs.remove(sysPath.join(root, 'jsconfig.json'));
  await fs.remove(sysPath.join(root, 'jsconfig.server.json'));

  const packageJson = await fs.readJSON(sysPath.join(root, 'package.json'));
  const { scripts, ...otherConfigs } = packageJson;
  scripts.eslint = 'eslint --fix \"./src/**/*.{ts,tsx}\"';
  scripts.prettier = 'prettier --list-different \"./src/**/*.{ts,tsx,md}\"';
  const newPackageJson = { ...otherConfigs, scripts };
  await fs.writeJSON(sysPath.join(root, 'package.json'), newPackageJson, { spaces: 2 });

  const installCmd = getInstallCmd();
  const useYarn = installCmd === 'yarn';
  const buildCmd = useYarn ? ['build'] : ['run', 'build'];

  await execa(installCmd, buildCmd);
  output.success('Succeed to initialize');
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

  const isPmndrs = projectStyle === 'pmndrs';
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
  
  const typescript = projectOption === 'typescript';
  const root = sysPath.resolve(projectName);

  await install(projectName, typescript);
  process.chdir(projectPath);

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
