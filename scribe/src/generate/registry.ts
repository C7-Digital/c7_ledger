import type { AnalyzedPackage, AnalyzedModule } from "../analyze.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Generate the versionedRegistry function and all registration calls.
 *
 * The generated function conforms to the VersionedRegistry type from
 * @c7-digital/ledger (structurally, without importing it).
 */
export function generateRegistry(
  mainPkg: AnalyzedPackage | undefined,
  vendorPkgs: AnalyzedPackage[],
  config: ResolvedConfig
): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("// Version-aware template registry");
  lines.push("const _registry = new Map();");
  lines.push("");

  // registerTemplateWithVersion helper
  lines.push("const _registerTemplate = (template, prefixVersionPairs) => {");
  lines.push(
    "  const templateName = template.templateId.split(':').slice(1).join(':');"
  );
  lines.push("  prefixVersionPairs.forEach(([prefix, version]) => {");
  lines.push("    const templateId = `${prefix}:${templateName}`;");
  lines.push("    if (_registry.has(templateId)) {");
  lines.push(
    "      console.warn(`Trying to re-register template ${templateId}.`);"
  );
  lines.push("    } else {");
  lines.push(
    "      _registry.set(templateId, { type: 'template', template, version });"
  );
  lines.push("    }");
  lines.push("  });");
  lines.push("};");
  lines.push("");

  // registerInterfaceWithVersion helper
  lines.push("const _registerInterface = (interface_, prefixVersionPairs) => {");
  lines.push(
    "  const interfaceName = interface_.templateId.split(':').slice(1).join(':');"
  );
  lines.push("  prefixVersionPairs.forEach(([prefix, version]) => {");
  lines.push("    const interfaceId = `${prefix}:${interfaceName}`;");
  lines.push("    if (_registry.has(interfaceId)) {");
  lines.push(
    "      console.warn(`Trying to re-register interface ${interfaceId}.`);"
  );
  lines.push("    } else {");
  lines.push(
    "      _registry.set(interfaceId, { type: 'interface', interface_, version });"
  );
  lines.push("    }");
  lines.push("  });");
  lines.push("};");
  lines.push("");

  // Registration calls for main package
  if (mainPkg) {
    const versionPairs = buildVersionPairs(mainPkg, config);
    lines.push(
      `// Register main package templates (${mainPkg.name})`
    );
    for (const mod of mainPkg.modules) {
      for (const member of mod.members) {
        const fn =
          member.kind === "interface"
            ? "_registerInterface"
            : "_registerTemplate";
        lines.push(
          `${fn}(${mod.alias}.${member.name}, ${JSON.stringify(versionPairs)});`
        );
      }
    }
    lines.push("");
  }

  // Registration calls for vendor packages
  for (const vendor of vendorPkgs) {
    const versionPairs = buildVendorVersionPairs(vendor);
    lines.push(`// Register vendor package templates (${vendor.name})`);
    for (const mod of vendor.modules) {
      for (const member of mod.members) {
        const fn =
          member.kind === "interface"
            ? "_registerInterface"
            : "_registerTemplate";
        lines.push(
          `${fn}(${mod.alias}.${member.name}, ${JSON.stringify(versionPairs)});`
        );
      }
    }
    lines.push("");
  }

  // Exported versionedRegistry function
  lines.push("// Conforms to VersionedRegistry from @c7-digital/ledger");
  lines.push("export const versionedRegistry = (templateId) => {");
  lines.push("  const exactMatch = _registry.get(templateId);");
  lines.push("  if (exactMatch) return exactMatch;");
  lines.push("");
  lines.push("  const colonIndex = templateId.indexOf(':');");
  lines.push("  if (colonIndex === -1) return undefined;");
  lines.push("");
  lines.push("  const templateName = templateId.substring(colonIndex + 1);");
  lines.push("  for (const [registeredId, value] of _registry) {");
  lines.push(
    "    if (registeredId.startsWith('#') && registeredId.endsWith(':' + templateName)) {"
  );
  lines.push("      return value;");
  lines.push("    }");
  lines.push("  }");
  lines.push("  return undefined;");
  lines.push("};");
  lines.push("");

  // Convenience re-exports (backward compat with existing lookupTemplate API)
  lines.push("export const lookupTemplate = versionedRegistry;");
  lines.push("");
  lines.push("export const getRegisteredTemplates = () => {");
  lines.push("  return Array.from(_registry.keys());");
  lines.push("};");

  return lines.join("\n");
}

/**
 * Build [prefix, version] pairs for the main package.
 * Includes compat hashes, current packageId hash, and generic # prefix.
 */
function buildVersionPairs(
  pkg: AnalyzedPackage,
  config: ResolvedConfig
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  // Compat versions (old hashes)
  for (const compat of config.compat.versions) {
    pairs.push([compat.hash, compat.version]);
  }

  // Current version hash
  pairs.push([pkg.packageId, pkg.version]);

  // Generic package prefix (strip trailing version from name)
  const baseName = pkg.name.replace(/-\d+\.\d+\.\d+.*$/, "");
  pairs.push([`#${baseName}`, pkg.version]);

  return pairs;
}

/**
 * Build [prefix, version] pairs for vendor packages.
 * No compat versions -- just the packageId and generic prefix.
 */
function buildVendorVersionPairs(
  pkg: AnalyzedPackage
): Array<[string, string]> {
  const baseName = pkg.name.replace(/-\d+\.\d+\.\d+.*$/, "");
  return [
    [pkg.packageId, pkg.version],
    [`#${baseName}`, pkg.version],
  ];
}
