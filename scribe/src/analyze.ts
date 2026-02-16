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
    /export\s+declare\s+const\s+packageId\s*=\s*['"]([0-9a-f]+)['"]/
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
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`Warning: could not read ${moduleDtsPath}: ${code ?? err}`);
    }
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
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(`Warning: could not read directory ${dir}: ${code ?? err}`);
      }
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
  // Config version override only applies to the main package
  const version =
    pkg.role === "main"
      ? (config.version ?? pkg.detectedVersion ?? "0.0.0")
      : (pkg.detectedVersion ?? "0.0.0");
  let modules = await discoverModules(pkg.path, pkg.role);

  // Apply config overrides for main package
  if (pkg.role === "main" && config.main.modules) {
    modules = applyModuleOverrides(modules, config.main.modules);
  }

  // Apply config overrides for vendor packages
  if (pkg.role === "vendor" && config.vendor) {
    const vendorOverride = findVendorOverride(pkg.name, config.vendor);
    if (vendorOverride?.modules) {
      modules = applyModuleOverrides(modules, vendorOverride.modules);
    }
  }

  return {
    ...pkg,
    packageId,
    version,
    modules,
  };
}

/**
 * Apply config-driven overrides to discovered modules:
 * - If overrides specify modules, only include those (filter)
 * - Apply alias overrides
 * - If overrides specify templates/interfaces, only include those (filter members)
 */
function applyModuleOverrides(
  discovered: AnalyzedModule[],
  overrides: Record<string, { alias?: string; templates?: string[]; interfaces?: string[] }>
): AnalyzedModule[] {
  const overrideKeys = Object.keys(overrides);
  const result: AnalyzedModule[] = [];

  for (const key of overrideKeys) {
    const override = overrides[key]!;
    // Find discovered module matching this key (by name)
    const mod = discovered.find((m) => m.name === key);
    if (!mod) {
      console.warn(`Config references module "${key}" but it was not found.`);
      continue;
    }

    let members = mod.members;

    // Filter templates if specified
    if (override.templates) {
      const allowedTemplates = new Set(override.templates);
      members = members.filter(
        (m) => m.kind !== "template" || allowedTemplates.has(m.name)
      );
    }

    // Filter interfaces if specified
    if (override.interfaces) {
      const allowedInterfaces = new Set(override.interfaces);
      members = members.filter(
        (m) => m.kind !== "interface" || allowedInterfaces.has(m.name)
      );
    }

    result.push({
      ...mod,
      alias: override.alias ?? mod.alias,
      members,
    });
  }

  return result;
}

/** Find the vendor override config entry matching a package name. */
function findVendorOverride(
  pkgName: string,
  vendorConfig: Record<string, { alias?: string; modules?: Record<string, { alias?: string; templates?: string[]; interfaces?: string[] }> }>
): { alias?: string; modules?: Record<string, { alias?: string; templates?: string[]; interfaces?: string[] }> } | undefined {
  for (const pattern of Object.keys(vendorConfig)) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    if (regex.test(pkgName)) {
      return vendorConfig[pattern];
    }
  }
  return undefined;
}
