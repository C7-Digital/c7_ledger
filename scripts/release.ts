import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

const LEDGER_PACKAGE_PATH = 'ledger/package.json';
const REACT_PACKAGE_PATH = 'react/package.json';
const ROOT_PACKAGE_PATH = 'package.json';

function exec(command: string, options = {}) {
  return execSync(command, { stdio: 'inherit', ...options });
}

function readPackageJson(path: string) {
  const fullPath = resolve(process.cwd(), path);
  return JSON.parse(readFileSync(fullPath, 'utf-8'));
}

function writePackageJson(path: string, content: any) {
  const fullPath = resolve(process.cwd(), path);
  writeFileSync(fullPath, JSON.stringify(content, null, 2) + '\n');
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log('C7 Ledger Release Script\n');
  
  const confirmation = await prompt('Have you updated the version to release before running this script? (y/n) ');
  if (confirmation.toLowerCase() !== 'y') {
    console.log('Please update the version in package.json files before running the release script.');
    process.exit(1);
  }
  
  const ledgerPkg = readPackageJson(LEDGER_PACKAGE_PATH);
  const reactPkg = readPackageJson(REACT_PACKAGE_PATH);

  const nextVersion = ledgerPkg.version;

  console.log(`Releasing version: ${nextVersion}\n`);
  
  // Run build
  console.log('Running build...');
  try {
    exec('pnpm build');
    console.log('✓ Build successful\n');
  } catch (error) {
    console.error('✗ Build failed');
    process.exit(1);
  }
  
  // Run tests
  console.log('Running tests...');
  try {
    exec('pnpm test');
    console.log('✓ All tests passed\n');
  } catch (error) {
    console.error('✗ Tests failed');
    process.exit(1);
  }

  // Update package.json files
  console.log('Updating package versions...');

  // Update react package (including peer dependency)
  const updatedReactPkg = {
    ...reactPkg,
    version: nextVersion,
    peerDependencies: {
      ...reactPkg.peerDependencies,
      '@c7/ledger': `^${nextVersion}`,
    },
  };
  writePackageJson(REACT_PACKAGE_PATH, updatedReactPkg);


  console.log('✓ Package versions updated\n');

  // Show what will be published
  console.log('Ready to publish:');
  console.log(`  - @c7/ledger@${nextVersion}`);
  console.log(`  - @c7/react@${nextVersion}`);
  console.log('');

  // Confirm with user
  const answer = await prompt('Continue with publish? (y/n) ');

  if (answer.toLowerCase() !== 'y') {
    console.log('\nRelease cancelled. Reverting changes...');

    // Revert changes
    writePackageJson(REACT_PACKAGE_PATH, reactPkg);

    console.log('✓ Changes reverted');
    process.exit(0);
  }

  console.log('');

  // Publish packages
  console.log(`Publishing @c7/ledger@${nextVersion}...`);
  try {
    exec(`npm publish --access public`, { cwd: resolve(process.cwd(),
  'ledger') });
    console.log(`✓ Published @c7/ledger\n`);
  } catch (error) {
    console.error(`✗ Failed to publish @c7/ledger`);
    process.exit(1);
  }

  console.log(`Publishing @c7/react@${nextVersion}...`);
  try {
    exec(`npm publish --access public`, { cwd: resolve(process.cwd(),
  'react') });
    console.log(`✓ Published @c7/react\n`);
  } catch (error) {
    console.error(`✗ Failed to publish @c7/react`);
    process.exit(1);
  }

  console.log(`Done! Published version ${nextVersion}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
