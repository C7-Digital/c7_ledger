import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.js";

export type PackageRole = "main" | "vendor" | "stdlib";

export interface DiscoveredPackage {
  /** Directory name, e.g. "domain-verification-model-0.0.8" */
  name: string;
  /** Absolute path to the package directory */
  path: string;
  /** Classified role */
  role: PackageRole;
  /** Version extracted from directory name, e.g. "0.0.8" */
  detectedVersion?: string;
}

const STDLIB_PREFIXES = ["daml-prim-", "daml-stdlib-", "ghc-stdlib-"];
const VENDOR_PREFIXES = ["splice-"];

function classifyPackage(
  name: string,
  mainPattern: string | undefined
): PackageRole {
  if (STDLIB_PREFIXES.some((p) => name.startsWith(p))) return "stdlib";

  if (mainPattern) {
    const regex = new RegExp(
      "^" + mainPattern.replace(/\*/g, ".*") + "$"
    );
    if (regex.test(name)) return "main";
  }

  if (VENDOR_PREFIXES.some((p) => name.startsWith(p))) return "vendor";

  // If no mainPattern was given, non-stdlib non-vendor packages are candidates for main
  return mainPattern ? "vendor" : "main";
}

function extractVersion(name: string): string | undefined {
  // Match trailing version: "my-project-0.1.0" -> "0.1.0"
  const match = name.match(/-(\d+\.\d+\.\d+(?:[.-].*)?)$/);
  return match?.[1];
}

export async function discoverPackages(
  config: ResolvedConfig
): Promise<DiscoveredPackage[]> {
  const entries = await readdir(config.input, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink());

  const packages: DiscoveredPackage[] = dirs.map((entry) => ({
    name: entry.name,
    path: join(config.input, entry.name),
    role: classifyPackage(entry.name, config.main.pattern),
    detectedVersion: extractVersion(entry.name),
  }));

  // Validate: exactly one main package (or zero if only vendor/stdlib)
  const mainPackages = packages.filter((p) => p.role === "main");
  if (mainPackages.length > 1 && !config.main.pattern) {
    const names = mainPackages.map((p) => p.name).join(", ");
    throw new Error(
      `Could not auto-detect main package. Found multiple non-vendor packages: ${names}\n` +
        `Hint: specify main.pattern in scribe.yaml to disambiguate.`
    );
  }

  return packages;
}
