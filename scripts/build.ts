#!/usr/bin/env tsx

/**
 * Unified build script that uses SDK version-based spec files and runs all build steps
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { readdir, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";

import { brandTypes } from "./enhance-types.js";
import { generateSchemaModule } from "./generate-schema-modules.js";
import { generateAsyncApiTypes } from "./generate-asyncapi-types.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

interface SpecFiles {
  openapi?: string;
  asyncapi?: string;
}

/**
 * Get SDK version from command line arguments or discover latest
 */
function getSdkVersion(): string | undefined {
  const args = process.argv.slice(2);
  const versionArg = args.find(arg => arg.startsWith("--sdk-version="));

  if (versionArg) {
    return versionArg.split("=")[1];
  }

  return undefined;
}

/**
 * Discover spec files based on SDK version or find latest version-based specs
 */
async function discoverSpecFiles(
  sdkVersion?: string
): Promise<{ specs: SpecFiles; version: string }> {
  const specsDir = join(projectRoot, "specs");
  const files = await readdir(specsDir);

  if (sdkVersion) {
    console.log(`🔍 Looking for spec files with SDK version: ${sdkVersion}`);

    const openApiFile = `openapi_${sdkVersion}.yaml`;
    const asyncApiFile = `asyncapi_${sdkVersion}.yaml`;

    const result: SpecFiles = {};

    if (files.includes(openApiFile)) {
      result.openapi = join(specsDir, openApiFile);
      console.log(`📄 Found OpenAPI spec: ${openApiFile}`);
    } else {
      console.warn(`⚠️  OpenAPI spec not found: ${openApiFile}`);
    }

    if (files.includes(asyncApiFile)) {
      result.asyncapi = join(specsDir, asyncApiFile);
      console.log(`📄 Found AsyncAPI spec: ${asyncApiFile}`);
    } else {
      console.warn(`⚠️  AsyncAPI spec not found: ${asyncApiFile}`);
    }

    return { specs: result, version: sdkVersion };
  } else {
    console.log("🔍 Auto-discovering latest version-based spec files...");

    // Look for files with version pattern (not date pattern)
    const versionPattern = /\d+\.\d+\.\d+(-snapshot\.\d{8}\.\d+)?/;
    const openApiFiles = files
      .filter(f => f.startsWith("openapi_") && f.endsWith(".yaml") && versionPattern.test(f))
      .sort()
      .reverse();
    const asyncApiFiles = files
      .filter(f => f.startsWith("asyncapi_") && f.endsWith(".yaml") && versionPattern.test(f))
      .sort()
      .reverse();

    const result: SpecFiles = {};
    let detectedVersion = "";

    if (openApiFiles.length > 0) {
      result.openapi = join(specsDir, openApiFiles[0]!);
      console.log(`📄 Found OpenAPI spec: ${openApiFiles[0]}`);
      // Extract version from filename
      const match = openApiFiles[0]!.match(/openapi_(.+)\.yaml/);
      if (match) detectedVersion = match[1]!;
    }

    if (asyncApiFiles.length > 0) {
      result.asyncapi = join(specsDir, asyncApiFiles[0]!);
      console.log(`📄 Found AsyncAPI spec: ${asyncApiFiles[0]}`);
      // Use version from AsyncAPI if OpenAPI wasn't found
      if (!detectedVersion) {
        const match = asyncApiFiles[0]!.match(/asyncapi_(.+)\.yaml/);
        if (match) detectedVersion = match[1]!;
      }
    }

    if (!detectedVersion) {
      throw new Error(
        "Could not detect SDK version from spec files. Please specify --sdk-version=<version>"
      );
    }

    console.log(`🎯 Detected SDK version: ${detectedVersion}`);
    return { specs: result, version: detectedVersion };
  }
}

/**
 * Generate OpenAPI types using openapi-typescript
 */
async function generateTypes(specPath: string): Promise<void> {
  console.log("🔄 Generating OpenAPI types...");
  const outputPath = join(projectRoot, "src", "generated", "api.ts");

  try {
    const { stdout, stderr } = await execAsync(
      `pnpm exec openapi-typescript "${specPath}" --output "${outputPath}"`
    );

    if (stderr && !stderr.includes("Warning")) {
      console.warn("openapi-typescript warnings:", stderr);
    }

    if (stdout) {
      console.log(stdout);
    }

    console.log("✅ Generated OpenAPI types");
  } catch (error) {
    console.error("❌ Error generating OpenAPI types:", (error as Error).message);
    throw error;
  }
}

/**
 * Generate schema modules for both OpenAPI and AsyncAPI
 */
function generateSchemaModules(specs: SpecFiles): void {
  console.log("🔄 Generating schema modules...");
  const outputDir = join(projectRoot, "src", "generated");

  if (specs.openapi) {
    generateSchemaModule(specs.openapi, join(outputDir, "openapi-schema.ts"), "OPENAPI_SCHEMA");
  }

  if (specs.asyncapi) {
    generateSchemaModule(specs.asyncapi, join(outputDir, "asyncapi-schema.ts"), "ASYNCAPI_SCHEMA");
  }

  console.log("✅ All schema modules generated");
}

/**
 * Ensure the generated directory exists
 */
async function ensureGeneratedDirectory(): Promise<void> {
  const outputDir = join(projectRoot, "src", "generated");
  await mkdir(outputDir, { recursive: true });
}

/**
 * Clean up any temporary files
 */
async function cleanupTempFiles(): Promise<void> {
  const generatedDir = join(projectRoot, "src", "generated");
  const tempFiles = [
    join(generatedDir, "api.ts.tmp"),
    join(generatedDir, "async-api.ts.tmp"),
    join(projectRoot, "temp-asyncapi-as-openapi.yaml"),
  ];

  for (const tempFile of tempFiles) {
    if (existsSync(tempFile)) {
      try {
        await unlink(tempFile);
        console.log(`🧹 Cleaned up ${tempFile}`);
      } catch (error) {
        // Ignore cleanup errors, but log them
        console.warn(`⚠️  Could not clean up ${tempFile}:`, (error as Error).message);
      }
    }
  }
}

/**
 * Generate SDK version constant file
 */
async function generateSdkVersionFile(version: string): Promise<void> {
  console.log("🔄 Generating SDK version constant...");
  const outputDir = join(projectRoot, "src", "generated");
  const outputPath = join(outputDir, "sdk-version.ts");

  const content = `// Auto-generated file - do not edit manually
// Generated from SDK version: ${version}

export const SDK_VERSION = "${version}";
`;

  await writeFile(outputPath, content, "utf-8");
  console.log(`✅ Generated SDK version constant: ${version}`);
}

/**
 * Brand API types with value.proto constraints (in-place)
 */
function brandApiTypes(): void {
  console.log("🔄 Branding API types in-place...");

  // Brand OpenAPI types (overwrite original file)
  const apiPath = join(projectRoot, "src", "generated", "api.ts");
  brandTypes(apiPath, apiPath, "OpenAPI");

  // Brand AsyncAPI types (overwrite original file)
  const asyncApiPath = join(projectRoot, "src", "generated", "async-api.ts");
  brandTypes(asyncApiPath, asyncApiPath, "AsyncAPI");

  console.log("✅ All types branded in-place");
}

/**
 * Create stub schema files for lite build
 */
async function createStubSchemaFiles(): Promise<void> {
  console.log("🔄 Creating stub schema files for lite build...");
  const outputDir = join(projectRoot, "src", "generated");

  const openApiStub = `// Stub file for lite build - no schema content
export const OPENAPI_SCHEMA = "";
`;

  const asyncApiStub = `// Stub file for lite build - no schema content  
export const ASYNCAPI_SCHEMA = "";
`;

  await writeFile(join(outputDir, "openapi-schema.ts"), openApiStub, "utf-8");
  await writeFile(join(outputDir, "asyncapi-schema.ts"), asyncApiStub, "utf-8");

  console.log("✅ Created stub schema files");
}

/**
 * Compile TypeScript code
 */
async function compileTypeScript(outDir: string = "lib"): Promise<void> {
  console.log(`🔄 Compiling TypeScript to ${outDir}...`);

  try {
    let tscCommand = `pnpm exec tsc -p ${join(projectRoot, "tsconfig.json")}`;
    let aliasCommand = `pnpm exec tsc-alias -p ${join(projectRoot, "tsconfig.json")}`;

    if (outDir !== "lib") {
      // Create a temporary tsconfig for different output directory
      const tempTsConfig = {
        extends: "./tsconfig.json",
        compilerOptions: {
          outDir: `./${outDir}`,
          declarationDir: `./${outDir}`,
        },
      };

      const tempConfigPath = join(projectRoot, "tsconfig.temp.json");
      await writeFile(tempConfigPath, JSON.stringify(tempTsConfig, null, 2), "utf-8");

      tscCommand = `pnpm exec tsc -p ${tempConfigPath}`;
      aliasCommand = `pnpm exec tsc-alias -p ${tempConfigPath}`;
    }

    // Run tsc first (tsc-alias depends on tsc output)
    const { stdout: tscStdout, stderr: tscStderr } = await execAsync(tscCommand);

    if (tscStderr) {
      console.error("TypeScript compiler errors/warnings:");
      console.error(tscStderr);
    }

    if (tscStdout) {
      console.log("TypeScript compiler output:");
      console.log(tscStdout);
    }

    // Run tsc-alias after tsc completes
    const { stdout: aliasStdout, stderr: aliasStderr } = await execAsync(aliasCommand);

    if (aliasStderr) {
      console.warn("tsc-alias warnings:", aliasStderr);
    }

    if (aliasStdout) {
      console.log(aliasStdout);
    }

    // Clean up temp config if created
    if (outDir !== "lib") {
      const tempConfigPath = join(projectRoot, "tsconfig.temp.json");
      if (existsSync(tempConfigPath)) {
        await unlink(tempConfigPath);
      }
    }

    console.log(`✅ TypeScript compilation complete for ${outDir}`);
  } catch (error) {
    console.error(`❌ Error compiling TypeScript to ${outDir}:`);
    console.error((error as Error).message);

    // If the error has stdout/stderr, display them
    if (error && typeof error === "object" && "stdout" in error && error.stdout) {
      console.error("TypeScript stdout:");
      console.error(error.stdout);
    }
    if (error && typeof error === "object" && "stderr" in error && error.stderr) {
      console.error("TypeScript stderr:");
      console.error(error.stderr);
    }

    console.error("💡 Note: TypeScript compilation failed, but code generation was successful.");
    console.error("💡 Check the errors above and fix any type issues in your source files.");
    throw error;
  }
}

/**
 * Main build function - builds both regular and lite versions
 */
async function build(): Promise<void> {
  console.log("🚀 Starting SDK version-aware build process...");

  try {
    // Step 1: Get SDK version and discover spec files
    const sdkVersion = getSdkVersion();
    const { specs, version } = await discoverSpecFiles(sdkVersion);

    if (!specs.openapi && !specs.asyncapi) {
      throw new Error(`No spec files found for SDK version: ${version}`);
    }

    // Step 2: Ensure generated directory exists
    await ensureGeneratedDirectory();

    // Step 3: Generate SDK version constant (independent, can run early)
    const sdkVersionPromise = generateSdkVersionFile(version);

    // Step 4: Run type generation in parallel (all independent)
    const parallelTasks: Promise<any>[] = [];

    if (specs.openapi) {
      parallelTasks.push(generateTypes(specs.openapi));
    }

    if (specs.asyncapi) {
      parallelTasks.push(generateAsyncApiTypes(specs.asyncapi));
    }

    // Wait for SDK version file and all parallel type generation
    await Promise.all([sdkVersionPromise, ...parallelTasks]);

    // Step 5: Brand types (depends on generated types)
    brandApiTypes();

    console.log("🎯 Building regular version with full schemas...");

    // Step 6a: Generate full schema modules for regular build
    generateSchemaModules(specs);

    // Step 6b: Compile regular TypeScript (depends on all previous steps)
    await compileTypeScript("lib");

    console.log("🎯 Building lite version without schemas...");

    // Step 7a: Create stub schema files for lite build
    await createStubSchemaFiles();

    // Step 7b: Compile lite TypeScript to separate directory
    await compileTypeScript("lib-lite");

    // Step 8: Clean up any temporary files
    await cleanupTempFiles();

    console.log(`🎉 Both regular and lite builds completed successfully for version: ${version}!`);
    console.log(`📦 Regular build: lib/ (with validation schemas)`);
    console.log(`📦 Lite build: lib-lite/ (without validation schemas)`);
  } catch (error) {
    console.error("❌ Build failed:", (error as Error).message);

    // Attempt cleanup even on failure
    try {
      await cleanupTempFiles();
    } catch (cleanupError) {
      console.warn("⚠️  Could not clean up temp files after build failure");
    }

    process.exit(1);
  }
}

// Run the build if this script is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build();
}

// Export for use in other scripts
export { build };
