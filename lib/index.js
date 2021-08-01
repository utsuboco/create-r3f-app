'use strict';

const fs = require('fs');
const chalk = require('chalk');

const messages = require('./utils/messages');
const checkForUpdate = require('./utils/check-for-update');
const processExit = require('./utils/process-exit');
const next = require('./stacks/next');

// todo add gatsby and native
const appTypes = ['next'];

module.exports = async function createR3fApp({ projectName, appType, projectOption }) {
  console.log(chalk.bold(chalk.blue(`Welcome. Project's generation started using create-R3F-App 🐱`)));

  await checkForUpdate();

  let appStyle;

  if (!projectName) {
    messages.missingProjectName();
    process.exit(1);
  }

  if (appTypes.indexOf(appType) === -1) {
    messages.invalidAppType(appType);
    process.exit(1);
  }

  if ((appType === 'next') && process.argv[4] === 'styled') {
    appStyle = 'styled';
  }

  if (fs.existsSync(projectName)) {
    messages.alreadyExists(projectName);
    process.exit(1);
  }

  if (appType === 'native' && !process.argv[4]) {
    messages.missingBundleId(projectName);
    process.exit(1);
  }

  const projectPath = `${process.cwd()}/${projectName}`;

  switch (appType) {
    case 'next':
      next(projectName, projectPath, appStyle, projectOption);
      break;
    default:
      break;
  }

  process.on('exit', () => processExit(projectPath, projectName, appType));
};
