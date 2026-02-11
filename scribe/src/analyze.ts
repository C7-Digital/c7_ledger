import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.js";
import type { DiscoveredPackage } from "./discover.js";

export interface AnalyzedTemplate {
  name: string;
  kind: "template" | "interface";
}

export interface AnalyzedModule {
  /** Module name, e.g. "InternetDomainName" */
  name: string;
  /** Relative path from package root to module directory */
  modulePath: string;
  /** Export alias (from config or auto-generated) */
  alias: string;
  /** Templates and interfaces found in this module */
  members: AnalyzedTemplate[];
}

export interface AnalyzedPackage extends DiscoveredPackage {
  packageId: string;
  version: string;
  modules: AnalyzedModule[];
}

/**
 * Extract packageId from lib/index.d.ts.
 * Looks for: export declare const packageId = "...";
 */
async function extractPackageId(pkgPath: string): Promise<string> {
  const indexDts = join(pkgPath, "lib", "index.d.ts");
  const content = await readFile(indexDts, "utf-8");
  const match = content.match(
    /export\s+declare\s+const\s+packageId\s*=\s*"([0-9a-f]+)"/
  );
  if (!match?.[1]) {
    throw new Error(
      `Could not extract packageId from ${indexDts}`
    );
  }
  return match[1];
}

/**
 * Scan a module.d.ts file and classify exports as templates or interfaces.
 *
 * Templates have a `templateId` field and a `Template` type in their declaration.
 * Interfaces have an `InterfaceCompanion` type.
 */
async function discoverMembers(
  moduleDtsPath: string
): Promise<AnalyzedTemplate[]> {
  let content: string;
  try {
    content = await readFile(moduleDtsPath, "utf-8");
  } catch {
    return [];
  }

  const members: AnalyzedTemplate[] = [];

  // Match exported consts that look like template or interface companions.
  // Pattern: export declare const Foo : ...Template<...>... or ...InterfaceCompanion<...>...
  const regex =
    /export\s+declare\s+const\s+(\w+)\s*:\s*.*?(Template|InterfaceCompanion)\s*</g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    const kind = m[2] === "InterfaceCompanion" ? "interface" : "template";
    members.push({ name, kind });
  }

  return members;
}

/**
 * Discover modules inside a package's lib/ directory.
 * Each subdirectory under lib/ that contains module.d.ts (or an index.d.ts
 * for nested modules like Splice/Amulet/) is a module.
 */
async function discoverModules(
  pkgPath: string,
  role: DiscoveredPackage["role"]
): Promise<AnalyzedModule[]> {
  const libPath = join(pkgPath, "lib");
  const modules: AnalyzedModule[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdir = join(dir, entry.name);
      const moduleDts = join(subdir, "module.d.ts");
      const indexDts = join(subdir, "index.d.ts");

      // Check if this directory has module.d.ts (leaf module)
      let dtsPath: string | undefined;
      try {
        await stat(moduleDts);
        dtsPath = moduleDts;
      } catch {
        try {
          await stat(indexDts);
          dtsPath = indexDts;
        } catch {
          // Not a leaf module; recurse
        }
      }

      const moduleName = prefix ? `${prefix}.${entry.name}` : entry.name;

      if (dtsPath) {
        const members = await discoverMembers(dtsPath);
        const alias = moduleName.replace(/\./g, "_");
        modules.push({
          name: moduleName,
          modulePath: dtsPath.replace(libPath + "/", "").replace(/\.d\.ts$/, ""),
          alias,
          members,
        });
      }

      // Always recurse for nested modules (e.g., Splice/Amulet/)
      await walk(subdir, moduleName);
    }
  }

  await walk(libPath, "");
  return modules;
}

export async function analyzePackage(
  pkg: DiscoveredPackage,
  config: ResolvedConfig
): Promise<AnalyzedPackage> {
  const packageId = await extractPackageId(pkg.path);
  const version =
    config.version ?? pkg.detectedVersion ?? "0.0.0";
  const modules = await discoverModules(pkg.path, pkg.role);

  return {
    ...pkg,
    packageId,
    version,
    modules,
  };
}
