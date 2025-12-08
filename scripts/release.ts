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

function getNextVersion(currentVersion: string): string {
  const match = currentVersion.match(/^(\d+\.\d+\.\d+)(?:_(\d+))?$/);
  if (!match) {
    throw new Error(`Invalid version format: ${currentVersion}`);
  }

  const baseVersion = match[1];
  const preRelease = match[2] ? parseInt(match[2], 10) : -1;

  return `${baseVersion}-${preRelease + 1}`;
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

  // Read current version
  const ledgerPkg = readPackageJson(LEDGER_PACKAGE_PATH);
  const currentVersion = ledgerPkg.version;
  const nextVersion = getNextVersion(currentVersion);

  console.log(`Current version: ${currentVersion}`);
  console.log(`Next version: ${nextVersion}\n`);

  
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

  // Update ledger package
  const updatedLedgerPkg = { ...ledgerPkg, version: nextVersion };
  writePackageJson(LEDGER_PACKAGE_PATH, updatedLedgerPkg);

  // Update react package (including peer dependency)
  const reactPkg = readPackageJson(REACT_PACKAGE_PATH);
  const updatedReactPkg = {
    ...reactPkg,
    version: nextVersion,
    peerDependencies: {
      ...reactPkg.peerDependencies,
      '@c7/ledger': `^${nextVersion}`,
    },
  };
  writePackageJson(REACT_PACKAGE_PATH, updatedReactPkg);

  // Update root package
  const rootPkg = readPackageJson(ROOT_PACKAGE_PATH);
  writePackageJson(ROOT_PACKAGE_PATH, { ...rootPkg, version: nextVersion });

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
    writePackageJson(LEDGER_PACKAGE_PATH, ledgerPkg);
    writePackageJson(REACT_PACKAGE_PATH, reactPkg);
    writePackageJson(ROOT_PACKAGE_PATH, rootPkg);

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

  // Commit version changes
  console.log('Committing version changes...');
  try {
    exec(`git add ${ROOT_PACKAGE_PATH} ${LEDGER_PACKAGE_PATH} ${REACT_PACKAGE_PATH}`);
    exec(`git commit -m "Release v${nextVersion}"`);
    console.log('✓ Changes committed\n');
  } catch (error) {
    console.error('✗ Failed to commit changes');
    process.exit(1);
  }

  // Create git tag
  console.log(`Creating git tag v${nextVersion}...`);
  try {
    exec(`git tag v${nextVersion}`);
    console.log('✓ Tag created\n');
  } catch (error) {
    console.error('✗ Failed to create tag');
    process.exit(1);
  }

  console.log(`Done! Published version ${nextVersion}`);
  console.log(`\nTo push the tag to remote, run:`);
  console.log(`  git push && git push origin v${nextVersion}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
