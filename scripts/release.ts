import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

const LEDGER_PACKAGE_PATH = 'ledger/package.json';
const REACT_PACKAGE_PATH = 'react/package.json';
const SCRIBE_PACKAGE_PATH = 'scribe/package.json';
const SCAN_PACKAGE_PATH = 'scan/package.json';

const VALID_PACKAGES = ['ledger', 'react', 'scribe', 'scan'] as const;
type PackageName = (typeof VALID_PACKAGES)[number];

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

function parsePackageSelection(): Set<PackageName> {
  const args = process.argv.slice(2);
  const packageIndex = args.findIndex(arg => arg === '--package');

  if (packageIndex === -1) {
    return new Set(VALID_PACKAGES);
  }

  const names = args.slice(packageIndex + 1);

  if (names.length === 0) {
    console.error('Missing --package value');
    console.error('Valid options: ledger, react, scribe, scan (e.g. --package ledger react)');
    process.exit(1);
  }

  const invalid = names.filter(n => !(VALID_PACKAGES as readonly string[]).includes(n));

  if (invalid.length > 0) {
    console.error(`Invalid --package value(s): ${invalid.join(', ')}`);
    console.error('Valid options: ledger, react, scribe, scan (e.g. --package ledger react)');
    process.exit(1);
  }

  return new Set(names as PackageName[]);
}

// Compares two `major.minor.patch` strings. Returns <0, 0 or >0.
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// True if `version` falls inside the peer range. Accepts the two forms the repo
// uses: an exact caret pin (`^0.0.35`) and a widened lower-bounded range
// (`>=0.0.33 <0.1.0`, set deliberately so react need not re-bump per ledger
// patch). Any other shape, or a range that does not admit `version`, is false.
function peerRangeAdmits(peerDep: string | undefined, version: string): boolean {
  if (!peerDep) return false;
  if (peerDep === `^${version}`) return true;

  const range = peerDep.match(/^>=(\d+\.\d+\.\d+)\s+<(\d+\.\d+\.\d+)$/);
  if (!range) return false;
  const [, lower, upper] = range;
  return compareVersion(version, lower) >= 0 && compareVersion(version, upper) < 0;
}

function validatePeerDependency(reactPkg: any, ledgerVersion: string): void {
  const peerDep = reactPkg.peerDependencies?.['@c7-digital/ledger'];

  if (!peerRangeAdmits(peerDep, ledgerVersion)) {
    console.error('\n✗ Validation failed: React peer dependency mismatch');
    console.error(`  Ledger version:        ${ledgerVersion}`);
    console.error(`  React peer dependency: "@c7-digital/ledger": "${peerDep || '(not set)'}"`);
    console.error(`\nThe react peer range must admit ${ledgerVersion} — either "^${ledgerVersion}"`);
    console.error('or a widened range such as ">=0.0.33 <0.1.0". Update react/package.json.');
    process.exit(1);
  }
}

async function main() {
  console.log('C7 Ledger Release Script\n');

  const packageSelection = parsePackageSelection();

  // Determine which packages are being released
  const releasingLedger = packageSelection.has('ledger');
  const releasingReact = packageSelection.has('react');
  const releasingScribe = packageSelection.has('scribe');
  const releasingScan = packageSelection.has('scan');

  // Display what will be released
  if (packageSelection.size === VALID_PACKAGES.length) {
    console.log('Releasing: All packages\n');
  } else {
    const names = [...packageSelection].map(p => `@c7-digital/${p}`).join(', ');
    console.log(`Releasing: ${names}\n`);
  }

  // Read package versions independently
  const ledgerPkg = readPackageJson(LEDGER_PACKAGE_PATH);
  const reactPkg = readPackageJson(REACT_PACKAGE_PATH);
  const scribePkg = readPackageJson(SCRIBE_PACKAGE_PATH);
  const scanPkg = readPackageJson(SCAN_PACKAGE_PATH);
  const ledgerVersion = ledgerPkg.version;
  const reactVersion = reactPkg.version;
  const scribeVersion = scribePkg.version;
  const scanVersion = scanPkg.version;

  
  // Confirm versions have been updated
  const packagesToUpdate = packageSelection.size === VALID_PACKAGES.length
    ? 'all packages'
    : [...packageSelection].map(p => `@c7-digital/${p}`).join(', ');
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

  // Clean before build
  console.log('Cleaning previous builds...');
  try {
    exec('pnpm clean');
    console.log('✓ Clean successful\n');
  } catch (error) {
    console.error('✗ Clean failed');
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

  // Show what will be published
  console.log('Ready to publish:');
  if (releasingLedger) {
    console.log(`  - @c7-digital/ledger@${ledgerVersion}`);
  }
  if (releasingReact) {
    console.log(`  - @c7-digital/react@${reactVersion}`);
  }
  if (releasingScribe) {
    console.log(`  - @c7-digital/scribe@${scribeVersion}`);
  }
  if (releasingScan) {
    console.log(`  - @c7-digital/scan@${scanVersion}`);
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
    console.log(`Publishing @c7-digital/ledger@${ledgerVersion}...`);
    try {
      exec(`npm publish --access public`, { cwd: resolve(process.cwd(), 'ledger') });
      console.log(`✓ Published @c7-digital/ledger\n`);
    } catch (error) {
      console.error(`✗ Failed to publish @c7-digital/ledger`);
      process.exit(1);
    }
  }

  if (releasingReact) {
    console.log(`Publishing @c7-digital/react@${reactVersion}...`);
    try {
      exec(`npm publish --access public`, { cwd: resolve(process.cwd(), 'react') });
      console.log(`✓ Published @c7-digital/react\n`);
    } catch (error) {
      console.error(`✗ Failed to publish @c7-digital/react`);
      process.exit(1);
    }
  }

  if (releasingScribe) {
    console.log(`Publishing @c7-digital/scribe@${scribeVersion}...`);
    try {
      exec(`npm publish --access public`, { cwd: resolve(process.cwd(), 'scribe') });
      console.log(`✓ Published @c7-digital/scribe\n`);
    } catch (error) {
      console.error(`✗ Failed to publish @c7-digital/scribe`);
      process.exit(1);
    }
  }

  if (releasingScan) {
    console.log(`Publishing @c7-digital/scan@${scanVersion}...`);
    try {
      exec(`npm publish --access public`, { cwd: resolve(process.cwd(), 'scan') });
      console.log(`✓ Published @c7-digital/scan\n`);
    } catch (error) {
      console.error(`✗ Failed to publish @c7-digital/scan`);
      process.exit(1);
    }
  }

  // Final success message
  const publishedPackages: string[] = [];
  if (releasingLedger) publishedPackages.push(`@c7-digital/ledger@${ledgerVersion}`);
  if (releasingReact) publishedPackages.push(`@c7-digital/react@${reactVersion}`);
  if (releasingScribe) publishedPackages.push(`@c7-digital/scribe@${scribeVersion}`);
  if (releasingScan) publishedPackages.push(`@c7-digital/scan@${scanVersion}`);

  console.log(`Done! Published ${publishedPackages.join(' and ')}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
