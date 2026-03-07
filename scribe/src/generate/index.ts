import { mkdir, writeFile, symlink, readdir, rm, copyFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { AnalyzedPackage } from "../analyze.js";
import type { ResolvedConfig } from "../config.js";
import { generateImports, generateExportStatements } from "./exports.js";
import { generateRegistry } from "./registry.js";
import { generateTypeDefs, generateVersionTypeDef } from "./types.js";
import { bundle } from "../transform.js";

export { generateImports, generateExportStatements } from "./exports.js";
export { generateRegistry } from "./registry.js";
export { generateTypeDefs, generateVersionTypeDef } from "./types.js";

export interface GenerateResult {
  mainPkg?: AnalyzedPackage;
  vendorPkgs: AnalyzedPackage[];
  stdlibPkgs: AnalyzedPackage[];
  outputDir: string;
  files: string[];
}

export async function generate(
  packages: AnalyzedPackage[],
  config: ResolvedConfig
): Promise<GenerateResult> {
  const mainPkg = packages.find((p) => p.role === "main");
  const vendorPkgs = packages.filter((p) => p.role === "vendor");
  const stdlibPkgs = packages.filter((p) => p.role === "stdlib");

  // Determine version for the main package
  const version = config.version ?? mainPkg?.version ?? "0.0.0";
  if (mainPkg) {
    mainPkg.version = version;
  }

  if (config.dryRun) {
    printSummary(mainPkg, vendorPkgs, config);
    return { mainPkg, vendorPkgs, stdlibPkgs, outputDir: config.output.dir, files: [] };
  }

  // Prepare a staging directory (.scribe/) adjacent to output
  const outputDir = config.output.dir;
  const srcDir = resolve(outputDir, "..", ".scribe");

  // Clean and recreate .scribe/
  await rm(srcDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true });

  // Symlink all input packages into src/ using relative paths
  const realSrcDir = await realpath(srcDir);
  const inputEntries = await readdir(config.input, { withFileTypes: true });
  for (const entry of inputEntries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const absTarget = resolve(join(config.input, entry.name));
      const target = relative(realSrcDir, absTarget);
      const link = join(srcDir, entry.name);
      await symlink(target, link);
    }
  }

  // Generate version.js
  await writeFile(
    join(srcDir, "version.js"),
    `export const PACKAGE_VERSION = '${version}';\n`
  );

  // Generate index.js
  const indexJs = [
    generateImports(mainPkg, vendorPkgs, stdlibPkgs),
    "",
    generateExportStatements(mainPkg, vendorPkgs),
    generateRegistry(mainPkg, vendorPkgs, config),
  ].join("\n");
  await writeFile(join(srcDir, "index.js"), indexJs);

  // Generate index.d.ts
  const indexDts = generateTypeDefs(mainPkg, vendorPkgs);
  await writeFile(join(srcDir, "index.d.ts"), indexDts);

  // Generate version.d.ts
  await writeFile(join(srcDir, "version.d.ts"), generateVersionTypeDef());

  const files = [".scribe/index.js", ".scribe/index.d.ts", ".scribe/version.js", ".scribe/version.d.ts"];

  // Bundle if configured
  if (config.output.bundle) {
    console.log("Bundling with Vite...");
    await bundle(srcDir, outputDir);

    // Copy type declarations to output dir
    await copyFile(join(srcDir, "index.d.ts"), join(outputDir, "index.d.ts"));
    await copyFile(join(srcDir, "version.d.ts"), join(outputDir, "version.d.ts"));

    files.push("dist/codegen.js", "dist/index.js", "dist/version.js", "dist/index.d.ts", "dist/version.d.ts");
  }

  printSummary(mainPkg, vendorPkgs, config);

  return { mainPkg, vendorPkgs, stdlibPkgs, outputDir, files };
}

function printSummary(
  mainPkg: AnalyzedPackage | undefined,
  vendorPkgs: AnalyzedPackage[],
  config: ResolvedConfig
): void {
  console.log("");
  console.log("Scribe complete:");

  if (mainPkg) {
    const templateCount = mainPkg.modules.reduce(
      (acc, m) => acc + m.members.filter((t) => t.kind === "template").length,
      0
    );
    const interfaceCount = mainPkg.modules.reduce(
      (acc, m) => acc + m.members.filter((t) => t.kind === "interface").length,
      0
    );
    const parts = [`${mainPkg.modules.length} modules`, `${templateCount} templates`];
    if (interfaceCount > 0) parts.push(`${interfaceCount} interfaces`);
    console.log(`  Main: ${mainPkg.name} (${parts.join(", ")})`);
  }

  for (const vendor of vendorPkgs) {
    const templateCount = vendor.modules.reduce(
      (acc, m) => acc + m.members.filter((t) => t.kind === "template").length,
      0
    );
    const interfaceCount = vendor.modules.reduce(
      (acc, m) => acc + m.members.filter((t) => t.kind === "interface").length,
      0
    );
    const parts = [`${vendor.modules.length} modules`];
    if (templateCount > 0) parts.push(`${templateCount} templates`);
    if (interfaceCount > 0) parts.push(`${interfaceCount} interfaces`);
    console.log(`  Vendor: ${vendor.name} (${parts.join(", ")})`);
  }

  if (config.dryRun) {
    console.log("  (dry run -- no files written)");
  }
  console.log("");
}
