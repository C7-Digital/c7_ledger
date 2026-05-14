#!/usr/bin/env tsx

/**
 * Downloads Scan API OpenAPI specs from the Splice repo and bundles them
 * into a single resolved YAML file.
 *
 * The raw spec has $ref references to sibling files:
 *   - common-external.yaml (health endpoints, error responses)
 *   - common-internal.yaml (DSO schemas, validator license schemas)
 *
 * We download all three, then resolve all external $ref references into a
 * single bundled YAML file. Schemas referenced via local #/components/schemas
 * refs in external files are collected into the root document.
 */

import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { writeFile, mkdir, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/hyperledger-labs/splice";

interface SpecSource {
  repoPath: string;
  filename: string;
}

const SCAN_SPEC: SpecSource = {
  repoPath: "apps/scan/src/main/openapi",
  filename: "scan.yaml",
};

const COMMON_SPECS: SpecSource[] = [
  {
    repoPath: "apps/common/src/main/openapi",
    filename: "common-external.yaml",
  },
  {
    repoPath: "apps/common/src/main/openapi",
    filename: "common-internal.yaml",
  },
];

function getSpliceVersion(): string {
  const args = process.argv.slice(2);
  const versionArg = args.find(arg => arg.startsWith("--splice-version="));
  if (versionArg) {
    return versionArg.split("=")[1]!;
  }
  return "0.6.1";
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`  Downloading: ${url}`);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const content = await response.text();
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, content, "utf-8");
}

async function downloadSpecs(version: string, tempDir: string): Promise<string> {
  console.log(`\nDownloading Scan API specs for Splice ${version}...\n`);

  const scanUrl = `${GITHUB_RAW_BASE}/${version}/${SCAN_SPEC.repoPath}/${SCAN_SPEC.filename}`;
  const scanDest = join(tempDir, SCAN_SPEC.repoPath, SCAN_SPEC.filename);
  await downloadFile(scanUrl, scanDest);

  for (const spec of COMMON_SPECS) {
    const url = `${GITHUB_RAW_BASE}/${version}/${spec.repoPath}/${spec.filename}`;
    const dest = join(tempDir, spec.repoPath, spec.filename);
    await downloadFile(url, dest);
  }

  return scanDest;
}

async function parseYamlFile(filePath: string): Promise<any> {
  const content = await readFile(filePath, "utf-8");
  return YAML.parse(content);
}

function parseRef(ref: string, currentFilePath: string): { filePath: string; pointer: string } {
  const hashIndex = ref.indexOf("#");
  if (hashIndex === -1) {
    return { filePath: resolve(dirname(currentFilePath), ref), pointer: "" };
  }
  const fileRef = ref.substring(0, hashIndex);
  const pointer = ref.substring(hashIndex + 1);
  if (!fileRef) {
    return { filePath: currentFilePath, pointer };
  }
  return { filePath: resolve(dirname(currentFilePath), fileRef), pointer };
}

function resolvePointer(obj: any, pointer: string): any {
  if (!pointer || pointer === "/") return obj;
  const parts = pointer.split("/").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === undefined || current === null) {
      throw new Error(`Cannot resolve pointer "${pointer}" — reached undefined at "${decoded}"`);
    }
    current = current[decoded];
  }
  return current;
}

const fileCache = new Map<string, any>();

async function getFileContent(filePath: string): Promise<any> {
  if (fileCache.has(filePath)) {
    return fileCache.get(filePath);
  }
  const content = await parseYamlFile(filePath);
  fileCache.set(filePath, content);
  return content;
}

/**
 * Track schemas to collect from external files.
 * Maps schema name to its fully-resolved schema object.
 */
const collectedSchemas = new Map<string, any>();

/**
 * Scan an object for local $ref patterns like "#/components/schemas/Foo"
 */
function findLocalSchemaRefs(obj: any): Set<string> {
  const refs = new Set<string>();
  const seen = new Set<any>();

  function walk(node: any): void {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if ("$ref" in node && typeof node["$ref"] === "string") {
      const ref: string = node["$ref"];
      const match = ref.match(/^#\/components\/schemas\/(.+)$/);
      if (match) {
        refs.add(match[1]!);
      }
      return;
    }

    for (const value of Object.values(node)) {
      walk(value);
    }
  }

  walk(obj);
  return refs;
}

/**
 * Fully resolve a schema from an external file, including all its external $refs.
 * The resulting object only contains local #/ refs (pointing to our root schemas).
 */
async function resolveSchemaDeep(
  schema: any,
  sourceFilePath: string,
  rootSchemas: Record<string, any>,
  processingSet: Set<string>,
): Promise<any> {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema !== "object") return schema;

  if (Array.isArray(schema)) {
    const resolved = [];
    for (const item of schema) {
      resolved.push(await resolveSchemaDeep(item, sourceFilePath, rootSchemas, processingSet));
    }
    return resolved;
  }

  if ("$ref" in schema && typeof schema["$ref"] === "string") {
    const refString: string = schema["$ref"];

    // Local ref to #/components/schemas/X — check if we need to collect it
    if (refString.startsWith("#/components/schemas/")) {
      const schemaName = refString.substring("#/components/schemas/".length);

      // If not in root schemas and not already collected, collect it
      if (!rootSchemas[schemaName] && !collectedSchemas.has(schemaName) && !processingSet.has(schemaName)) {
        const fileContent = await getFileContent(sourceFilePath);
        const externalSchema = fileContent?.components?.schemas?.[schemaName];
        if (externalSchema) {
          processingSet.add(schemaName);
          const resolved = await resolveSchemaDeep(externalSchema, sourceFilePath, rootSchemas, processingSet);
          collectedSchemas.set(schemaName, resolved);
          console.log(`  Collected schema: ${schemaName}`);
        }
      }
      // Keep as local ref
      return schema;
    }

    // Other local refs — keep as-is
    if (refString.startsWith("#")) {
      return schema;
    }

    // External ref — resolve it
    const { filePath, pointer } = parseRef(refString, sourceFilePath);
    const fileContent = await getFileContent(filePath);
    const resolved = resolvePointer(fileContent, pointer);

    // Recursively resolve
    return resolveSchemaDeep(resolved, filePath, rootSchemas, processingSet);
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = await resolveSchemaDeep(value, sourceFilePath, rootSchemas, processingSet);
  }
  return result;
}

/**
 * Recursively resolve all external $ref references in the root document.
 * When an external ref is inlined, any local schema refs it contains
 * are collected into collectedSchemas.
 */
async function resolveRefs(
  obj: any,
  currentFilePath: string,
  rootFilePath: string,
  rootSchemas: Record<string, any>,
): Promise<any> {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    const resolved = [];
    for (const item of obj) {
      resolved.push(await resolveRefs(item, currentFilePath, rootFilePath, rootSchemas));
    }
    return resolved;
  }

  if ("$ref" in obj && typeof obj["$ref"] === "string") {
    const refString: string = obj["$ref"];

    // Local refs — keep as-is
    if (refString.startsWith("#")) {
      return obj;
    }

    // External ref — fully resolve it (including nested external refs)
    const { filePath, pointer } = parseRef(refString, currentFilePath);
    const fileContent = await getFileContent(filePath);
    const resolved = resolvePointer(fileContent, pointer);

    // Deep-resolve: resolve all external refs and collect schemas
    return resolveSchemaDeep(resolved, filePath, rootSchemas, new Set());
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = await resolveRefs(value, currentFilePath, rootFilePath, rootSchemas);
  }
  return result;
}

async function bundleSpec(scanSpecPath: string, outputPath: string): Promise<void> {
  console.log(`\nBundling spec...`);

  const scanDoc = await parseYamlFile(scanSpecPath);

  // Get root schemas so we know what's already defined
  const rootSchemas = scanDoc?.components?.schemas || {};

  // Resolve all external $refs (this also collects external schemas)
  const bundled = await resolveRefs(scanDoc, scanSpecPath, scanSpecPath, rootSchemas);

  // Merge collected external schemas into the bundled document
  if (collectedSchemas.size > 0) {
    if (!bundled.components) bundled.components = {};
    if (!bundled.components.schemas) bundled.components.schemas = {};

    for (const [name, schema] of collectedSchemas) {
      if (!bundled.components.schemas[name]) {
        bundled.components.schemas[name] = schema;
      }
    }
  }

  const yamlOutput = YAML.stringify(bundled, { lineWidth: 0 });
  await writeFile(outputPath, yamlOutput, "utf-8");

  console.log(`\nBundled spec written to ${outputPath}`);
}

async function main(): Promise<void> {
  const version = getSpliceVersion();
  const outputPath = join(projectRoot, "specs", `scan_bundled_${version}.yaml`);

  if (existsSync(outputPath)) {
    console.log(`Bundled spec already exists: ${outputPath}`);
    console.log("Delete it first if you want to re-download.");
    return;
  }

  const tempDir = join(projectRoot, ".tmp-splice-specs");

  try {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true });
    }
    await mkdir(tempDir, { recursive: true });

    const scanSpecPath = await downloadSpecs(version, tempDir);
    await mkdir(dirname(outputPath), { recursive: true });
    await bundleSpec(scanSpecPath, outputPath);

    console.log(`\nDone! Bundled spec: ${outputPath}`);
  } finally {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true });
    }
  }
}

main().catch(error => {
  console.error("Error:", error.message);
  process.exit(1);
});
