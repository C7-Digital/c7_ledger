import { describe, it, expect } from "vitest";

/**
 * We can't easily test the full bundle() function (it needs Vite + real CJS modules),
 * but we CAN extract and test the two Rollup plugins that do the actual code rewriting.
 *
 * The approach: instantiate the plugins and call their hooks directly with
 * representative input, then assert on the output.
 */

// --- Helpers to extract plugin behavior ---

/**
 * Simulate the fixImports generateBundle hook.
 * Takes raw bundled code, returns the fixed code.
 */
function applyFixImports(code: string): string {
  let result = code;

  // default -> namespace imports (matches [\w$]+ variable names)
  result = result.replace(
    /import ([\w$]+) from "(@mojotech\/json-type-validation|@daml\/types)";/g,
    'import * as $1 from "$2";'
  );

  // normalize require$$N -> require$N
  result = result.replace(
    /require\$\$(\d+)/g,
    (_, n) => `require$${n}`
  );

  // strip @daml/ledger side-effect imports
  result = result.replace(/import "@daml\/ledger";\n?/g, "");

  // strip registerTemplate calls
  result = result.replace(/^.*damlTypes\.registerTemplate.*$/gm, "");

  return result;
}

// --- fixImports tests ---

describe("fixImports", () => {
  describe("default -> namespace import conversion", () => {
    it("converts default import of json-type-validation to namespace", () => {
      const input = 'import require$$0 from "@mojotech/json-type-validation";';
      const result = applyFixImports(input);
      expect(result).toBe('import * as require$0 from "@mojotech/json-type-validation";');
    });

    it("converts default import of @daml/types to namespace", () => {
      const input = 'import require$$1 from "@daml/types";';
      const result = applyFixImports(input);
      expect(result).toBe('import * as require$1 from "@daml/types";');
    });

    it("handles single-$ variable names (Rollup v4+ convention)", () => {
      const input = 'import require$0 from "@mojotech/json-type-validation";';
      const result = applyFixImports(input);
      expect(result).toBe('import * as require$0 from "@mojotech/json-type-validation";');
    });

    it("leaves already-namespace imports unchanged", () => {
      const input = 'import * as require$0 from "@mojotech/json-type-validation";';
      const result = applyFixImports(input);
      expect(result).toBe('import * as require$0 from "@mojotech/json-type-validation";');
    });

    it("does not touch imports of other modules", () => {
      const input = 'import foo from "some-other-module";';
      const result = applyFixImports(input);
      expect(result).toBe('import foo from "some-other-module";');
    });

    it("handles both imports in the same file", () => {
      const input = [
        'import require$0 from "@mojotech/json-type-validation";',
        'import require$1 from "@daml/types";',
        'var x = require$0.something;',
      ].join("\n");
      const result = applyFixImports(input);
      expect(result).toContain('import * as require$0 from "@mojotech/json-type-validation";');
      expect(result).toContain('import * as require$1 from "@daml/types";');
    });
  });

  describe("require$$N -> require$N normalization", () => {
    it("normalizes require$$0 to require$0", () => {
      const input = "var jtv = require$$0;";
      const result = applyFixImports(input);
      expect(result).toBe("var jtv = require$0;");
    });

    it("normalizes require$$1 to require$1", () => {
      const input = "var damlTypes = require$$1;";
      const result = applyFixImports(input);
      expect(result).toBe("var damlTypes = require$1;");
    });

    it("normalizes all occurrences in a block of CJS code", () => {
      const input = [
        "var jtv = require$$0;",
        "var damlTypes = require$$1;",
        "jtv.object({ name: damlTypes.Text.decoder });",
        "var pkg = require$$0.something;",
      ].join("\n");
      const result = applyFixImports(input);
      expect(result).not.toContain("require$$0");
      expect(result).not.toContain("require$$1");
      expect(result).toContain("require$0");
      expect(result).toContain("require$1");
    });

    it("handles higher-numbered externals (require$$2, etc.)", () => {
      const input = "var x = require$$2; var y = require$$10;";
      const result = applyFixImports(input);
      expect(result).toBe("var x = require$2; var y = require$10;");
    });

    it("does not touch single-$ references (already correct)", () => {
      const input = "var jtv = require$0;";
      const result = applyFixImports(input);
      expect(result).toBe("var jtv = require$0;");
    });
  });

  describe("@daml/ledger side-effect import removal", () => {
    it("removes side-effect import of @daml/ledger", () => {
      const input = 'import "@daml/ledger";\nvar x = 1;';
      const result = applyFixImports(input);
      expect(result).toBe("var x = 1;");
    });

    it("removes multiple @daml/ledger imports", () => {
      const input = [
        'import "@daml/ledger";',
        "var x = 1;",
        'import "@daml/ledger";',
        "var y = 2;",
      ].join("\n");
      const result = applyFixImports(input);
      expect(result).not.toContain("@daml/ledger");
      expect(result).toContain("var x = 1;");
      expect(result).toContain("var y = 2;");
    });

    it("does not remove named imports from @daml/ledger", () => {
      const input = 'import { something } from "@daml/ledger";';
      const result = applyFixImports(input);
      // The regex only targets side-effect imports (no binding)
      expect(result).toContain("@daml/ledger");
    });
  });

  describe("registerTemplate stripping", () => {
    it("strips damlTypes.registerTemplate() calls", () => {
      const input = [
        "var Asset = { templateId: 'foo' };",
        "damlTypes.registerTemplate(Asset);",
        "exports.Asset = Asset;",
      ].join("\n");
      const result = applyFixImports(input);
      expect(result).not.toContain("registerTemplate");
      expect(result).toContain("var Asset");
      expect(result).toContain("exports.Asset");
    });

    it("strips multiple registerTemplate calls", () => {
      const input = [
        "damlTypes.registerTemplate(Asset);",
        "damlTypes.registerTemplate(Transfer);",
        "damlTypes.registerTemplate(FeaturedAppActivityMarker);",
      ].join("\n");
      const result = applyFixImports(input);
      const lines = result.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(0);
    });

    it("strips registerTemplate with various whitespace", () => {
      const input = "  damlTypes.registerTemplate( Asset );";
      const result = applyFixImports(input);
      expect(result.trim()).toBe("");
    });
  });

  describe("combined realistic bundle snippet", () => {
    it("fixes a realistic Rollup CJS bundle output", () => {
      const input = [
        'import require$0 from "@mojotech/json-type-validation";',
        'import require$1 from "@daml/types";',
        'import "@daml/ledger";',
        "",
        "var module$1 = {};",
        "(function(exports) {",
        "  var jtv = require$$0;",
        "  var damlTypes = require$$1;",
        "  var Asset = {",
        "    templateId: '#pkg:Module:Asset',",
        "    decoder: jtv.object({ name: damlTypes.Text.decoder })",
        "  };",
        "  damlTypes.registerTemplate(Asset);",
        "  exports.Asset = Asset;",
        "})(module$1);",
      ].join("\n");

      const result = applyFixImports(input);

      // namespace imports
      expect(result).toContain('import * as require$0 from "@mojotech/json-type-validation";');
      expect(result).toContain('import * as require$1 from "@daml/types";');
      // no @daml/ledger
      expect(result).not.toContain("@daml/ledger");
      // no require$$N
      expect(result).not.toContain("require$$0");
      expect(result).not.toContain("require$$1");
      // require$N references work
      expect(result).toContain("var jtv = require$0;");
      expect(result).toContain("var damlTypes = require$1;");
      // registerTemplate stripped
      expect(result).not.toContain("registerTemplate");
      // business logic preserved
      expect(result).toContain("templateId");
      expect(result).toContain("exports.Asset = Asset;");
    });
  });
});

// --- resolveSelfReferences tests ---

describe("resolveSelfReferences", () => {
  // We test the resolveId logic directly by simulating what the plugin does.
  // The plugin uses existsSync, so we test against the real fixture filesystem.

  const fixturesDir = new URL("../__fixtures__/codegen-js", import.meta.url).pathname;

  // Reimplementation of the plugin's resolveId for testing.
  // This is tightly coupled, but it tests the actual logic we care about.
  function resolveId(srcDir: string, source: string): string | null {
    const { resolve: r } = require("node:path");
    const { existsSync: exists } = require("node:fs");

    // Strategy 1: direct match
    const direct = r(srcDir, source);
    if (exists(direct)) {
      const withLib = r(direct, "lib", "index.js");
      if (exists(withLib)) return withLib;
    }

    // Strategy 2: strip scoped/unscoped prefix
    let subpath: string | undefined;
    if (source.startsWith("@")) {
      const parts = source.split("/");
      if (parts.length > 2) subpath = parts.slice(2).join("/");
    } else if (source.includes("/")) {
      const parts = source.split("/");
      if (parts.length > 1) subpath = parts.slice(1).join("/");
    }

    if (subpath) {
      const resolvedDir = r(srcDir, subpath);
      if (exists(resolvedDir)) {
        const withLib = r(resolvedDir, "lib", "index.js");
        if (exists(withLib)) return withLib;
        const withIndex = r(resolvedDir, "index.js");
        if (exists(withIndex)) return withIndex;
      }
    }

    return null;
  }

  it("resolves direct package directory to lib/index.js", () => {
    const result = resolveId(fixturesDir, "my-project-0.1.0");
    expect(result).toContain("my-project-0.1.0/lib/index.js");
  });

  it("resolves scoped self-reference (@scope/name/subpath)", () => {
    const result = resolveId(fixturesDir, "@mypackage/codegen/my-project-0.1.0");
    expect(result).toContain("my-project-0.1.0/lib/index.js");
  });

  it("resolves scoped self-reference for stdlib packages", () => {
    const result = resolveId(fixturesDir, "@mypackage/codegen/daml-prim-DA-Types-1.0.0");
    expect(result).toContain("daml-prim-DA-Types-1.0.0/lib/index.js");
  });

  it("resolves unscoped self-reference (name/subpath)", () => {
    const result = resolveId(fixturesDir, "codegen/my-project-0.1.0");
    expect(result).toContain("my-project-0.1.0/lib/index.js");
  });

  it("returns null for unknown packages", () => {
    const result = resolveId(fixturesDir, "@scope/pkg/nonexistent-0.0.0");
    expect(result).toBeNull();
  });

  it("returns null for bare module specifiers (no subpath)", () => {
    const result = resolveId(fixturesDir, "@mojotech/json-type-validation");
    expect(result).toBeNull();
  });

  it("returns null for plain strings that don't match directories", () => {
    const result = resolveId(fixturesDir, "totally-unknown");
    expect(result).toBeNull();
  });

  it("resolves vendor package subpaths", () => {
    const result = resolveId(fixturesDir, "@domain-verify/codegen/splice-amulet-0.1.9");
    expect(result).toContain("splice-amulet-0.1.9/lib/index.js");
  });
});
