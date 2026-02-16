import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { discoverPackages } from "../discover.js";
import type { ResolvedConfig } from "../config.js";

const FIXTURES_INPUT = resolve(
  import.meta.dirname,
  "../__fixtures__/codegen-js"
);

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    input: FIXTURES_INPUT,
    output: { dir: "/tmp/scribe-test-out", bundle: false },
    main: {},
    compat: {},
    dryRun: false,
    ...overrides,
  };
}

describe("discoverPackages", () => {
  it("classifies stdlib packages", async () => {
    const pkgs = await discoverPackages(makeConfig());
    const stdlib = pkgs.filter((p) => p.role === "stdlib");
    const names = stdlib.map((p) => p.name).sort();
    expect(names).toEqual([
      "daml-prim-DA-Types-1.0.0",
      "daml-stdlib-DA-Set-Types-1.0.0",
    ]);
  });

  it("classifies vendor packages", async () => {
    const pkgs = await discoverPackages(makeConfig());
    const vendor = pkgs.filter((p) => p.role === "vendor");
    expect(vendor).toHaveLength(1);
    expect(vendor[0]!.name).toBe("splice-amulet-0.1.9");
  });

  it("auto-detects main package when only one non-stdlib/vendor exists", async () => {
    const pkgs = await discoverPackages(makeConfig());
    const main = pkgs.filter((p) => p.role === "main");
    expect(main).toHaveLength(1);
    expect(main[0]!.name).toBe("my-project-0.1.0");
  });

  it("uses pattern to identify main package", async () => {
    const pkgs = await discoverPackages(
      makeConfig({ main: { pattern: "my-project-*" } })
    );
    const main = pkgs.filter((p) => p.role === "main");
    expect(main).toHaveLength(1);
    expect(main[0]!.name).toBe("my-project-0.1.0");
  });

  it("extracts version from directory name", async () => {
    const pkgs = await discoverPackages(makeConfig());
    const main = pkgs.find((p) => p.name === "my-project-0.1.0");
    expect(main?.detectedVersion).toBe("0.1.0");

    const vendor = pkgs.find((p) => p.name === "splice-amulet-0.1.9");
    expect(vendor?.detectedVersion).toBe("0.1.9");
  });
});
