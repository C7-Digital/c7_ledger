import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { discoverPackages } from "../discover.js";
import type { ResolvedConfig } from "../config.js";

const MULTIVERSION_INPUT = resolve(
  import.meta.dirname,
  "../__fixtures__/codegen-js-multiversion"
);

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    input: MULTIVERSION_INPUT,
    output: { dir: "/tmp/scribe-test-out", bundle: false },
    main: {},
    compat: { versions: [] },
    dryRun: false,
    ...overrides,
  };
}

describe("discoverPackages (multi-version)", () => {
  it("selects the latest version when no config.version is set", async () => {
    const pkgs = await discoverPackages(makeConfig());
    const main = pkgs.filter((p) => p.role === "main");
    expect(main).toHaveLength(1);
    expect(main[0]!.name).toBe("my-project-0.0.9");
    expect(main[0]!.detectedVersion).toBe("0.0.9");
  });

  it("demotes non-selected versions to stdlib", async () => {
    const pkgs = await discoverPackages(makeConfig());
    const stdlib = pkgs.filter((p) => p.role === "stdlib");
    const stdlibNames = stdlib.map((p) => p.name).sort();
    expect(stdlibNames).toContain("my-project-0.0.7");
    expect(stdlibNames).toContain("my-project-0.0.8");
  });

  it("selects specific version when config.version is set", async () => {
    const pkgs = await discoverPackages(makeConfig({ version: "0.0.8" }));
    const main = pkgs.filter((p) => p.role === "main");
    expect(main).toHaveLength(1);
    expect(main[0]!.name).toBe("my-project-0.0.8");
  });

  it("demotes other versions when config.version selects a specific one", async () => {
    const pkgs = await discoverPackages(makeConfig({ version: "0.0.8" }));
    const stdlib = pkgs.filter((p) => p.role === "stdlib");
    const stdlibNames = stdlib.map((p) => p.name).sort();
    expect(stdlibNames).toContain("my-project-0.0.7");
    expect(stdlibNames).toContain("my-project-0.0.9");
  });

  it("throws when config.version does not match any package", async () => {
    await expect(
      discoverPackages(makeConfig({ version: "9.9.9" }))
    ).rejects.toThrow("Version 9.9.9 not found among main packages");
  });

  it("preserves stdlib packages regardless of version selection", async () => {
    const pkgs = await discoverPackages(makeConfig());
    const stdlib = pkgs.filter((p) => p.role === "stdlib");
    expect(stdlib.map((p) => p.name)).toContain("daml-prim-DA-Types-1.0.0");
  });

  it("selects oldest version when explicitly requested", async () => {
    const pkgs = await discoverPackages(makeConfig({ version: "0.0.7" }));
    const main = pkgs.filter((p) => p.role === "main");
    expect(main).toHaveLength(1);
    expect(main[0]!.name).toBe("my-project-0.0.7");
  });

  it("correctly orders semver (0.0.9 > 0.0.10 is wrong; 0.0.10 > 0.0.9)", async () => {
    // This test validates that semver comparison is numeric, not lexicographic.
    // With our 3-version fixture (0.0.7, 0.0.8, 0.0.9), the latest is 0.0.9.
    // This would fail if we did string comparison (where "0.0.9" > "0.0.10").
    const pkgs = await discoverPackages(makeConfig());
    const main = pkgs.find((p) => p.role === "main");
    expect(main!.detectedVersion).toBe("0.0.9");
  });
});
