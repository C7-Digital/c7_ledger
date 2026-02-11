import { describe, it, expect } from "vitest";
import type { AnalyzedPackage } from "../analyze.js";
import type { ResolvedConfig } from "../config.js";
import { generateImports, generateExportStatements } from "../generate/exports.js";
import { generateRegistry } from "../generate/registry.js";
import { generateTypeDefs, generateVersionTypeDef } from "../generate/types.js";

const mainPkg: AnalyzedPackage = {
  name: "my-project-0.1.0",
  path: "/fake/my-project-0.1.0",
  role: "main",
  detectedVersion: "0.1.0",
  packageId: "047836b8aaa",
  version: "0.1.0",
  modules: [
    {
      name: "MyModule",
      modulePath: "MyModule/module",
      alias: "MyModule",
      members: [
        { name: "Asset", kind: "template" },
        { name: "AssetTransfer", kind: "template" },
      ],
    },
    {
      name: "OtherModule",
      modulePath: "OtherModule/module",
      alias: "OtherModule",
      members: [{ name: "Record", kind: "template" }],
    },
  ],
};

const vendorPkg: AnalyzedPackage = {
  name: "splice-amulet-0.1.9",
  path: "/fake/splice-amulet-0.1.9",
  role: "vendor",
  detectedVersion: "0.1.9",
  packageId: "abc123def",
  version: "0.1.9",
  modules: [
    {
      name: "Splice.Amulet",
      modulePath: "Splice/Amulet/index",
      alias: "Splice_Amulet",
      members: [{ name: "FeaturedAppActivityMarker", kind: "template" }],
    },
  ],
};

const stdlibPkg: AnalyzedPackage = {
  name: "daml-prim-DA-Types-1.0.0",
  path: "/fake/daml-prim-DA-Types-1.0.0",
  role: "stdlib",
  detectedVersion: "1.0.0",
  packageId: "000prim",
  version: "1.0.0",
  modules: [],
};

const config: ResolvedConfig = {
  input: "/fake/input",
  output: { dir: "/fake/dist", bundle: false },
  main: {},
  compat: {
    versions: [
      { hash: "oldhash111", version: "0.0.9" },
    ],
  },
  dryRun: false,
};

describe("generateImports", () => {
  it("generates import statements for main modules", () => {
    const result = generateImports(mainPkg, [], []);
    expect(result).toContain(
      "import * as MyModule from './my-project-0.1.0/lib/MyModule/module.js';"
    );
    expect(result).toContain(
      "import * as OtherModule from './my-project-0.1.0/lib/OtherModule/module.js';"
    );
  });

  it("generates import statements for vendor packages", () => {
    const result = generateImports(undefined, [vendorPkg], []);
    // Package-level import for packageId access
    expect(result).toContain(
      "import * as splice_amulet_0_1_9 from './splice-amulet-0.1.9/lib/index.js';"
    );
    // Module-level import
    expect(result).toContain(
      "import * as Splice_Amulet from './splice-amulet-0.1.9/lib/Splice/Amulet/index.js';"
    );
  });

  it("generates import statements for stdlib packages", () => {
    const result = generateImports(undefined, [], [stdlibPkg]);
    expect(result).toContain(
      "import * as daml_prim_DA_Types_1_0_0 from './daml-prim-DA-Types-1.0.0/lib/index.js';"
    );
  });

  it("always imports version.js", () => {
    const result = generateImports(undefined, [], []);
    expect(result).toContain("import * as version from './version.js';");
  });
});

describe("generateExportStatements", () => {
  it("exports main and vendor module aliases", () => {
    const result = generateExportStatements(mainPkg, [vendorPkg]);
    expect(result).toContain("export { MyModule, OtherModule, Splice_Amulet };");
    expect(result).toContain("export { PACKAGE_VERSION } from './version.js';");
  });

  it("handles no main package", () => {
    const result = generateExportStatements(undefined, [vendorPkg]);
    expect(result).toContain("export { Splice_Amulet };");
  });
});

describe("generateRegistry", () => {
  it("generates registration calls for main package templates", () => {
    const result = generateRegistry(mainPkg, [], config);
    expect(result).toContain("_registerTemplate(MyModule.Asset,");
    expect(result).toContain("_registerTemplate(MyModule.AssetTransfer,");
    expect(result).toContain("_registerTemplate(OtherModule.Record,");
  });

  it("includes compat version hashes in registration", () => {
    const result = generateRegistry(mainPkg, [], config);
    expect(result).toContain('"oldhash111"');
    expect(result).toContain('"0.0.9"');
  });

  it("includes current packageId and generic prefix", () => {
    const result = generateRegistry(mainPkg, [], config);
    expect(result).toContain('"047836b8aaa"');
    expect(result).toContain('"#my-project"');
  });

  it("generates vendor registration with packageId and generic prefix", () => {
    const result = generateRegistry(undefined, [vendorPkg], config);
    expect(result).toContain(
      "_registerTemplate(Splice_Amulet.FeaturedAppActivityMarker,"
    );
    expect(result).toContain('"abc123def"');
    expect(result).toContain('"#splice-amulet"');
  });

  it("exports versionedRegistry and lookupTemplate", () => {
    const result = generateRegistry(mainPkg, [], config);
    expect(result).toContain("export const versionedRegistry =");
    expect(result).toContain("export const lookupTemplate = versionedRegistry;");
    expect(result).toContain("export const getRegisteredTemplates =");
  });
});

describe("generateTypeDefs", () => {
  it("generates re-export declarations for main modules", () => {
    const result = generateTypeDefs(mainPkg, []);
    expect(result).toContain(
      "export * as MyModule from './my-project-0.1.0/lib/MyModule/module';"
    );
    expect(result).toContain(
      "export * as OtherModule from './my-project-0.1.0/lib/OtherModule/module';"
    );
  });

  it("generates re-export declarations for vendor modules", () => {
    const result = generateTypeDefs(undefined, [vendorPkg]);
    expect(result).toContain(
      "export * as Splice_Amulet from './splice-amulet-0.1.9/lib/Splice/Amulet/index';"
    );
  });

  it("includes registry function declarations", () => {
    const result = generateTypeDefs(mainPkg, []);
    expect(result).toContain("export declare const versionedRegistry:");
    expect(result).toContain("export declare const lookupTemplate:");
    expect(result).toContain("export declare function getRegisteredTemplates():");
    expect(result).toContain("VersionedLookupResult");
  });

  it("exports PACKAGE_VERSION", () => {
    const result = generateTypeDefs(mainPkg, []);
    expect(result).toContain("export { PACKAGE_VERSION } from './version';");
  });
});

describe("generateVersionTypeDef", () => {
  it("declares PACKAGE_VERSION", () => {
    const result = generateVersionTypeDef();
    expect(result).toContain("export declare const PACKAGE_VERSION: string;");
  });
});
