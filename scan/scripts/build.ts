#!/usr/bin/env tsx

/**
 * Build script for @c7-digital/scan
 *
 * Steps:
 * 1. Parse --splice-version (default: 0.5.10)
 * 2. If bundled spec doesn't exist, run download-spec.ts
 * 3. Run openapi-typescript to generate types
 * 4. Generate sdk-version.ts constant
 * 5. Compile TypeScript (tsc + tsc-alias)
 */

import { join, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readdir, readFile, cp, unlink } from "fs/promises";
import { existsSync } from "fs";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

function getSpliceVersion(): string {
  const args = process.argv.slice(2);
  const versionArg = args.find(arg => arg.startsWith("--splice-version="));
  if (versionArg) {
    return versionArg.split("=")[1]!;
  }
  return "0.5.10";
}

async function discoverSpecFile(version?: string): Promise<{ specPath: string; version: string }> {
  const specsDir = join(projectRoot, "specs");

  if (version) {
    const specFile = `scan_bundled_${version}.yaml`;
    const specPath = join(specsDir, specFile);

    if (existsSync(specPath)) {
      console.log(`Found bundled spec: ${specFile}`);
      return { specPath, version };
    }

    // Spec doesn't exist yet — run download script
    console.log(`Bundled spec not found for ${version}, downloading...`);
    try {
      const { stdout, stderr } = await execAsync(
        `pnpm exec tsx "${join(projectRoot, "scripts", "download-spec.ts")}" --splice-version=${version}`,
        { cwd: projectRoot }
      );
      if (stdout) console.log(stdout);
      if (stderr) console.warn(stderr);
    } catch (error: any) {
      console.error("Failed to download spec:", error.stderr || error.message);
      throw error;
    }

    if (!existsSync(specPath)) {
      throw new Error(`Spec file still not found after download: ${specFile}`);
    }

    return { specPath, version };
  }

  // Auto-discover latest
  const files = await readdir(specsDir);
  const bundledSpecs = files
    .filter(f => f.startsWith("scan_bundled_") && f.endsWith(".yaml"))
    .sort()
    .reverse();

  if (bundledSpecs.length === 0) {
    throw new Error("No bundled spec files found. Run download-spec.ts first or specify --splice-version.");
  }

  const latestSpec = bundledSpecs[0]!;
  const match = latestSpec.match(/scan_bundled_(.+)\.yaml/);
  const detectedVersion = match ? match[1]! : "unknown";

  console.log(`Auto-discovered spec: ${latestSpec} (version: ${detectedVersion})`);
  return { specPath: join(specsDir, latestSpec), version: detectedVersion };
}

async function ensureGeneratedDirectory(): Promise<void> {
  const outputDir = join(projectRoot, "src", "generated");
  await mkdir(outputDir, { recursive: true });
}

async function generateTypes(specPath: string): Promise<void> {
  console.log("Generating OpenAPI types...");
  const outputPath = join(projectRoot, "src", "generated", "api.ts");

  try {
    const { stdout, stderr } = await execAsync(
      `pnpm exec openapi-typescript "${specPath}" --output "${outputPath}"`,
      { cwd: projectRoot }
    );

    if (stderr && !stderr.includes("Warning")) {
      console.warn("openapi-typescript warnings:", stderr);
    }
    if (stdout) {
      console.log(stdout);
    }

    console.log("Generated OpenAPI types successfully.");
  } catch (error) {
    console.error("Error generating OpenAPI types:", (error as Error).message);
    throw error;
  }
}

async function generateSpliceVersionFile(version: string): Promise<void> {
  console.log("Generating Splice version constant...");
  const outputDir = join(projectRoot, "src", "generated");
  const outputPath = join(outputDir, "sdk-version.ts");

  const content = `// Auto-generated file - do not edit manually
// Generated from Splice version: ${version}

export const SPLICE_VERSION = "${version}";
`;

  await writeFile(outputPath, content, "utf-8");
  console.log(`Generated Splice version constant: ${version}`);
}

async function compileTypeScript(): Promise<void> {
  console.log("Compiling TypeScript...");

  try {
    const tscCommand = `pnpm exec tsc -p ${join(projectRoot, "tsconfig.json")}`;
    const aliasCommand = `pnpm exec tsc-alias -p ${join(projectRoot, "tsconfig.json")}`;

    const { stdout: tscStdout, stderr: tscStderr } = await execAsync(tscCommand);
    if (tscStderr) {
      console.error("TypeScript compiler errors/warnings:");
      console.error(tscStderr);
    }
    if (tscStdout) {
      console.log(tscStdout);
    }

    const { stdout: aliasStdout, stderr: aliasStderr } = await execAsync(aliasCommand);
    if (aliasStderr) {
      console.warn("tsc-alias warnings:", aliasStderr);
    }
    if (aliasStdout) {
      console.log(aliasStdout);
    }

    console.log("TypeScript compilation complete.");
  } catch (error: any) {
    console.error("Error compiling TypeScript:");
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    throw error;
  }
}

async function embedSpliceCodegen(): Promise<void> {
  console.log("Embedding splice-codegen types...");

  // Look for splice-codegen's .scribe/ in multiple locations:
  // 1. Sibling workspace directory (../splice-codegen/.scribe)
  // 2. node_modules (when installed as a dependency)
  const candidates = [
    join(projectRoot, "..", "splice-codegen", ".scribe"),
    join(projectRoot, "node_modules", "@c7-digital", "splice-codegen", ".scribe"),
  ];
  const scribeDir = candidates.find(d => existsSync(d));
  const vendorDir = join(projectRoot, "lib", "_vendor", "splice-codegen");

  if (!scribeDir) {
    throw new Error(`splice-codegen .scribe directory not found. Searched:\n${candidates.join("\n")}`);
  }

  // Copy .scribe/ into lib/_vendor/splice-codegen/ (dereference symlinks)
  await cp(scribeDir, vendorDir, { recursive: true, dereference: true });
  console.log(`Copied .scribe/ → ${vendorDir}`);

  // Remove nested package.json files — they contain dependencies on
  // @c7-digital/splice-codegen/* that would confuse pnpm during install.
  // Only .d.ts files are needed for type resolution.
  await removeNestedPackageJsons(vendorDir);

  // Rewrite @c7-digital/splice-codegen imports in all .d.ts files under lib/
  const libDir = join(projectRoot, "lib");
  await rewriteImportsInDir(libDir, vendorDir);

  console.log("splice-codegen types embedded successfully.");
}

async function removeNestedPackageJsons(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await removeNestedPackageJsons(fullPath);
    } else if (entry.name === "package.json" || entry.name === "tsconfig.json" || entry.name.endsWith(".js")) {
      await unlink(fullPath);
    }
  }
}

/**
 * Recursively find .d.ts files and rewrite @c7-digital/splice-codegen imports
 * to relative paths pointing into _vendor/splice-codegen/.
 */
async function rewriteImportsInDir(dir: string, vendorDir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteImportsInDir(fullPath, vendorDir);
    } else if (entry.name.endsWith(".d.ts")) {
      let content = await readFile(fullPath, "utf-8");
      if (!content.includes("@c7-digital/splice-codegen")) continue;

      content = content.replace(
        /from\s+(['"])@c7-digital\/splice-codegen(?:\/([^'"]*))?\1/g,
        (_match, quote, subpath) => {
          const fileDir = dirname(fullPath);
          if (subpath) {
            // Subpath import: @c7-digital/splice-codegen/MODULE_NAME
            // Resolves to vendorDir/MODULE_NAME/lib/index
            const target = join(vendorDir, subpath, "lib", "index");
            let rel = relative(fileDir, target).split(sep).join("/");
            if (!rel.startsWith(".")) rel = "./" + rel;
            return `from ${quote}${rel}${quote}`;
          } else {
            // Root import: @c7-digital/splice-codegen
            // Resolves to vendorDir/index
            const target = join(vendorDir, "index");
            let rel = relative(fileDir, target).split(sep).join("/");
            if (!rel.startsWith(".")) rel = "./" + rel;
            return `from ${quote}${rel}${quote}`;
          }
        }
      );

      await writeFile(fullPath, content, "utf-8");
    }
  }
}

async function build(): Promise<void> {
  console.log("Starting @c7-digital/scan build...\n");

  try {
    const spliceVersion = getSpliceVersion();
    const { specPath, version } = await discoverSpecFile(spliceVersion);

    await ensureGeneratedDirectory();

    // Generate types and version constant in parallel
    await Promise.all([
      generateTypes(specPath),
      generateSpliceVersionFile(version),
    ]);

    // Compile TypeScript (depends on generated types)
    await compileTypeScript();

    // Embed splice-codegen types into lib/ so consumers don't need it installed
    await embedSpliceCodegen();

    console.log(`\nBuild completed successfully for Splice version: ${version}`);
  } catch (error) {
    console.error("Build failed:", (error as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build();
}

export { build };
