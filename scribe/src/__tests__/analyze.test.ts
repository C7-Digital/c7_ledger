import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { analyzePackage } from "../analyze.js";
import type { DiscoveredPackage } from "../discover.js";
import type { ResolvedConfig } from "../config.js";

const FIXTURES_INPUT = resolve(
  import.meta.dirname,
  "../__fixtures__/codegen-js"
);

const defaultConfig: ResolvedConfig = {
  input: FIXTURES_INPUT,
  output: { dir: "/tmp/scribe-test-out", bundle: false },
  main: {},
  compat: { versions: [] },
  dryRun: false,
};

describe("analyzePackage", () => {
  it("extracts packageId from main package", async () => {
    const pkg: DiscoveredPackage = {
      name: "my-project-0.1.0",
      path: resolve(FIXTURES_INPUT, "my-project-0.1.0"),
      role: "main",
      detectedVersion: "0.1.0",
    };

    const result = await analyzePackage(pkg, defaultConfig);
    expect(result.packageId).toBe(
      "047836b827eb98a192fa6a25c05d3b9f6365ca1533f42532266f45572f70eca6"
    );
  });

  it("uses config version over detected version", async () => {
    const pkg: DiscoveredPackage = {
      name: "my-project-0.1.0",
      path: resolve(FIXTURES_INPUT, "my-project-0.1.0"),
      role: "main",
      detectedVersion: "0.1.0",
    };

    const result = await analyzePackage(pkg, {
      ...defaultConfig,
      version: "9.9.9",
    });
    expect(result.version).toBe("9.9.9");
  });

  it("falls back to detected version when config version is absent", async () => {
    const pkg: DiscoveredPackage = {
      name: "my-project-0.1.0",
      path: resolve(FIXTURES_INPUT, "my-project-0.1.0"),
      role: "main",
      detectedVersion: "0.1.0",
    };

    const result = await analyzePackage(pkg, defaultConfig);
    expect(result.version).toBe("0.1.0");
  });

  it("discovers modules with templates", async () => {
    const pkg: DiscoveredPackage = {
      name: "my-project-0.1.0",
      path: resolve(FIXTURES_INPUT, "my-project-0.1.0"),
      role: "main",
      detectedVersion: "0.1.0",
    };

    const result = await analyzePackage(pkg, defaultConfig);
    const moduleNames = result.modules.map((m) => m.name).sort();
    expect(moduleNames).toEqual(["MyModule", "OtherModule"]);

    const myMod = result.modules.find((m) => m.name === "MyModule")!;
    expect(myMod.alias).toBe("MyModule");
    const memberNames = myMod.members.map((t) => t.name).sort();
    expect(memberNames).toEqual(["Asset", "AssetTransfer"]);
    expect(myMod.members.every((t) => t.kind === "template")).toBe(true);

    const otherMod = result.modules.find((m) => m.name === "OtherModule")!;
    expect(otherMod.members).toHaveLength(1);
    expect(otherMod.members[0]!.name).toBe("Record");
  });

  it("discovers nested vendor modules", async () => {
    const pkg: DiscoveredPackage = {
      name: "splice-amulet-0.1.9",
      path: resolve(FIXTURES_INPUT, "splice-amulet-0.1.9"),
      role: "vendor",
      detectedVersion: "0.1.9",
    };

    const result = await analyzePackage(pkg, defaultConfig);
    // Should find nested module Splice.Amulet
    const spliceMod = result.modules.find((m) => m.name === "Splice.Amulet");
    expect(spliceMod).toBeDefined();
    expect(spliceMod!.alias).toBe("Splice_Amulet");
    expect(spliceMod!.members).toHaveLength(1);
    expect(spliceMod!.members[0]!.name).toBe("FeaturedAppActivityMarker");
  });
});
