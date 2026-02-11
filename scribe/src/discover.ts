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

function globToRegex(pattern: string): RegExp {
  return new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
}

function classifyPackage(
  name: string,
  mainPattern: string | undefined,
  vendorPatterns: string[] | undefined
): PackageRole {
  if (STDLIB_PREFIXES.some((p) => name.startsWith(p))) return "stdlib";

  if (mainPattern) {
    if (globToRegex(mainPattern).test(name)) return "main";
  }

  // If vendor patterns are explicitly specified, only match those
  if (vendorPatterns && vendorPatterns.length > 0) {
    if (vendorPatterns.some((p) => globToRegex(p).test(name))) return "vendor";
    // If it doesn't match any vendor pattern and isn't main/stdlib, still classify
    // based on known prefixes but mark as stdlib (skip it)
    if (VENDOR_PREFIXES.some((p) => name.startsWith(p))) return "stdlib";
    // Non-vendor, non-stdlib, non-main pattern => candidate for main
    return mainPattern ? "stdlib" : "main";
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

  const vendorPatterns = config.vendor
    ? Object.keys(config.vendor)
    : undefined;

  let packages: DiscoveredPackage[] = dirs.map((entry) => ({
    name: entry.name,
    path: join(config.input, entry.name),
    role: classifyPackage(entry.name, config.main.pattern, vendorPatterns),
    detectedVersion: extractVersion(entry.name),
  }));

  // If multiple main packages match (e.g., model-0.0.7, model-0.0.8, model-0.0.9),
  // select the one matching config.version, or the latest version.
  const mainPackages = packages.filter((p) => p.role === "main");
  if (mainPackages.length > 1) {
    const targetVersion = config.version;
    let selected: DiscoveredPackage | undefined;

    if (targetVersion) {
      selected = mainPackages.find(
        (p) => p.detectedVersion === targetVersion
      );
      if (!selected) {
        const names = mainPackages.map((p) => p.name).join(", ");
        throw new Error(
          `Version ${targetVersion} not found among main packages: ${names}`
        );
      }
    } else {
      // Pick the latest version (sort semver descending)
      selected = mainPackages.sort((a, b) =>
        compareSemver(b.detectedVersion ?? "0.0.0", a.detectedVersion ?? "0.0.0")
      )[0];
    }

    // Demote non-selected main packages to stdlib (they'll be included for bundling but not exported)
    packages = packages.map((p) =>
      p.role === "main" && p !== selected ? { ...p, role: "stdlib" as const } : p
    );
  }

  return packages;
}

/** Simple semver comparison. Returns negative if a < b, positive if a > b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
