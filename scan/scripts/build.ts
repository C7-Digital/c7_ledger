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

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readdir } from "fs/promises";
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
