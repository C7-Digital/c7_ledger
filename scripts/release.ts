import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

const LEDGER_PACKAGE_PATH = 'ledger/package.json';
const REACT_PACKAGE_PATH = 'react/package.json';

type PackageSelection = 'ledger' | 'react' | 'all';

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

function parsePackageSelection(): PackageSelection {
  const args = process.argv.slice(2);
  const packageArg = args.find(arg => arg.startsWith('--package='));

  if (!packageArg) {
    return 'all';
  }

  const value = packageArg.split('=')[1] as PackageSelection;

  if (!['ledger', 'react', 'all'].includes(value)) {
    console.error(`Invalid --package value: ${value}`);
    console.error('Valid options: ledger, react, all');
    process.exit(1);
  }

  return value;
}

async function main() {
  console.log('C7 Ledger Release Script\n');

  const packageSelection = parsePackageSelection();

  // Determine which packages are being released
  const releasingLedger = packageSelection === 'ledger' || packageSelection === 'all';
  const releasingReact = packageSelection === 'react' || packageSelection === 'all';

  // Display what will be released
  if (packageSelection === 'all') {
    console.log('Releasing: Both packages\n');
  } else {
    console.log(`Releasing: @c7/${packageSelection} only\n`);
  }

  // Read package versions independently
  const ledgerPkg = readPackageJson(LEDGER_PACKAGE_PATH);
  const reactPkg = readPackageJson(REACT_PACKAGE_PATH);
  const ledgerVersion = ledgerPkg.version;
  const reactVersion = reactPkg.version;

  // Confirm versions have been updated
  const packagesToUpdate = packageSelection === 'all' ? 'both packages' : `@c7/${packageSelection}`;
  const confirmation = await prompt(`Have you updated the version for ${packagesToUpdate}? (y/n) `);
  if (confirmation.toLowerCase() !== 'y') {
    console.log('Please update the version(s) in the appropriate package.json file(s) before running the release script.');
    process.exit(1);
  }

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

  // Track if we made any changes (for revert functionality)
  let reactPkgModified = false;

  // Update react package peer dependency if ledger is being released
  if (releasingLedger) {
    console.log('Updating react peer dependency...');
    const updatedReactPkg = {
      ...reactPkg,
      peerDependencies: {
        ...reactPkg.peerDependencies,
        '@c7/ledger': `^${ledgerVersion}`,
      },
    };
    writePackageJson(REACT_PACKAGE_PATH, updatedReactPkg);
    reactPkgModified = true;
    console.log('✓ React peer dependency updated\n');
  }

  // Show what will be published
  console.log('Ready to publish:');
  if (releasingLedger) {
    console.log(`  - @c7/ledger@${ledgerVersion}`);
  }
  if (releasingReact) {
    console.log(`  - @c7/react@${reactVersion}`);
  }
  console.log('');

  // Confirm with user
  const answer = await prompt('Continue with publish? (y/n) ');

  if (answer.toLowerCase() !== 'y') {
    console.log('\nRelease canceled. Reverting changes...');

    // Only revert what we actually changed
    if (reactPkgModified) {
      writePackageJson(REACT_PACKAGE_PATH, reactPkg);
    }

    console.log('✓ Changes reverted');
    process.exit(0);
  }

  console.log('');

  // Publish packages
  if (releasingLedger) {
    console.log(`Publishing @c7/ledger@${ledgerVersion}...`);
    try {
      exec(`npm publish --access public`, { cwd: resolve(process.cwd(), 'ledger') });
      console.log(`✓ Published @c7/ledger\n`);
    } catch (error) {
      console.error(`✗ Failed to publish @c7/ledger`);
      process.exit(1);
    }
  }

  if (releasingReact) {
    console.log(`Publishing @c7/react@${reactVersion}...`);
    try {
      exec(`npm publish --access public`, { cwd: resolve(process.cwd(), 'react') });
      console.log(`✓ Published @c7/react\n`);
    } catch (error) {
      console.error(`✗ Failed to publish @c7/react`);
      process.exit(1);
    }
  }

  // Final success message
  const publishedPackages: string[] = [];
  if (releasingLedger) publishedPackages.push(`@c7/ledger@${ledgerVersion}`);
  if (releasingReact) publishedPackages.push(`@c7/react@${reactVersion}`);

  console.log(`Done! Published ${publishedPackages.join(' and ')}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
