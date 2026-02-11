import type { AnalyzedPackage } from "../analyze.js";

/**
 * Generate the index.d.ts TypeScript declaration file.
 */
export function generateTypeDefs(
  mainPkg: AnalyzedPackage | undefined,
  vendorPkgs: AnalyzedPackage[]
): string {
  const lines: string[] = [];

  // Module re-exports
  if (mainPkg) {
    for (const mod of mainPkg.modules) {
      const relPath = `./${mainPkg.name}/lib/${mod.modulePath}`;
      lines.push(
        `export * as ${mod.alias} from '${relPath}';`
      );
    }
  }

  for (const vendor of vendorPkgs) {
    for (const mod of vendor.modules) {
      const relPath = `./${vendor.name}/lib/${mod.modulePath}`;
      lines.push(
        `export * as ${mod.alias} from '${relPath}';`
      );
    }
  }

  lines.push("");
  lines.push("export { PACKAGE_VERSION } from './version';");
  lines.push("");

  // Registry function types (structurally compatible with @c7-digital/ledger)
  lines.push("import { InterfaceCompanion, Template } from '@daml/types';");
  lines.push("");
  lines.push("type VersionedLookupResult");
  lines.push(
    "  = { type: \"template\", template: Template<object, unknown, string>, version: string }"
  );
  lines.push(
    "  | { type: \"interface\", interface_: InterfaceCompanion<object, unknown, string>, version: string };"
  );
  lines.push("");
  lines.push(
    "/** Conforms to VersionedRegistry from @c7-digital/ledger. */"
  );
  lines.push(
    "export declare const versionedRegistry: (templateId: string) => VersionedLookupResult | undefined;"
  );
  lines.push(
    "export declare const lookupTemplate: (templateId: string) => VersionedLookupResult | undefined;"
  );
  lines.push("export declare function getRegisteredTemplates(): string[];");

  return lines.join("\n");
}

/**
 * Generate the version.d.ts declaration file.
 */
export function generateVersionTypeDef(): string {
  return "export declare const PACKAGE_VERSION: string;\n";
}
