import { execSync } from 'child_process';
import { readFileSync } from 'fs';
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
  const packageIndex = args.findIndex(arg => arg === '--package');

  if (packageIndex === -1) {
    return 'all';
  }

  const value = args[packageIndex + 1] as PackageSelection;

  if (!value || !['ledger', 'react', 'all'].includes(value)) {
    console.error(`Invalid --package value: ${value || 'none'}`);
    console.error('Valid options: ledger, react, all');
    process.exit(1);
  }

  return value;
}

function validatePeerDependency(reactPkg: any, ledgerVersion: string): void {
  const peerDep = reactPkg.peerDependencies?.['@c7/ledger'];
  const expectedPeerDep = `^${ledgerVersion}`;

  if (peerDep !== expectedPeerDep) {
    console.error('\n✗ Validation failed: React peer dependency mismatch');
    console.error(`  Expected: "@c7/ledger": "${expectedPeerDep}"`);
    console.error(`  Found:    "@c7/ledger": "${peerDep || '(not set)'}"`);
    console.error('\nPlease update the peer dependency in react/package.json to match the ledger version.');
    process.exit(1);
  }
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
  
  // Validate peer dependency if releasing ledger
  if (releasingLedger) {
    validatePeerDependency(reactPkg, ledgerVersion);
    console.log('✓ React peer dependency matches ledger version\n');
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
    console.log('\nRelease canceled.');
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
