import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

const PACKAGES = [
  { name: '@c7/ledger', path: 'ledger/package.json' },
  { name: '@c7/react', path: 'react/package.json' },
];

const ROOT_PACKAGE = 'package.json';

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
  const ledgerPkg = readPackageJson(PACKAGES[0].path);
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
  writePackageJson(PACKAGES[0].path, updatedLedgerPkg);

  // Update react package (including peer dependency)
  const reactPkg = readPackageJson(PACKAGES[1].path);
  const updatedReactPkg = {
    ...reactPkg,
    version: nextVersion,
    peerDependencies: {
      ...reactPkg.peerDependencies,
      '@c7/ledger': `^${nextVersion}`,
    },
  };
  writePackageJson(PACKAGES[1].path, updatedReactPkg);

  // Update root package
  const rootPkg = readPackageJson(ROOT_PACKAGE);
  writePackageJson(ROOT_PACKAGE, { ...rootPkg, version: nextVersion });

  console.log('✓ Package versions updated\n');

  // Show what will be published
  console.log('Ready to publish:');
  PACKAGES.forEach((pkg) => {
    console.log(`  - ${pkg.name}@${nextVersion}`);
  });
  console.log('');

  // Confirm with user
  const answer = await prompt('Continue with publish? (y/n) ');

  if (answer.toLowerCase() !== 'y') {
    console.log('\nRelease cancelled. Reverting changes...');

    // Revert changes
    writePackageJson(PACKAGES[0].path, ledgerPkg);
    writePackageJson(PACKAGES[1].path, reactPkg);
    writePackageJson(ROOT_PACKAGE, rootPkg);

    console.log('✓ Changes reverted');
    process.exit(0);
  }

  console.log('');

  // Publish packages
  for (const pkg of PACKAGES) {
    console.log(`Publishing ${pkg.name}@${nextVersion}...`);
    try {
      const pkgDir = pkg.path.replace('/package.json', '');
      exec(`npm publish --access public`, { cwd: resolve(process.cwd(), pkgDir) });
      console.log(`✓ Published ${pkg.name}\n`);
    } catch (error) {
      console.error(`✗ Failed to publish ${pkg.name}`);
      process.exit(1);
    }
  }

  // Commit version changes
  console.log('Committing version changes...');
  try {
    exec(`git add ${ROOT_PACKAGE} ${PACKAGES.map(p => p.path).join(' ')}`);
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
