import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";

const FIXTURES = resolve(import.meta.dirname, "../__fixtures__");

describe("loadConfig", () => {
  it("loads a YAML config file", async () => {
    const config = await loadConfig({
      config: resolve(FIXTURES, "scribe.yaml"),
    });

    expect(config.main.pattern).toBe("my-project-*");
    expect(config.compat.versions).toHaveLength(1);
    expect(config.compat.versions[0]!.version).toBe("0.0.9");
    expect(config.output.bundle).toBe(true);
    expect(config.output.dir).toMatch(/dist$/);
  });

  it("uses CLI overrides over config file", async () => {
    const config = await loadConfig({
      config: resolve(FIXTURES, "scribe.yaml"),
      input: "/override/input",
      output: "/override/output",
      version: "1.2.3",
    });

    expect(config.input).toBe("/override/input");
    expect(config.output.dir).toBe("/override/output");
    expect(config.version).toBe("1.2.3");
  });

  it("applies defaults when no config file is given", async () => {
    const config = await loadConfig({ input: "/some/path" });

    expect(config.input).toBe("/some/path");
    expect(config.output.dir).toMatch(/dist$/);
    expect(config.output.bundle).toBe(true);
    expect(config.main.pattern).toBeUndefined();
    expect(config.compat.versions).toEqual([]);
    expect(config.dryRun).toBe(false);
  });

  it("respects dryRun flag", async () => {
    const config = await loadConfig({ input: "/x", dryRun: true });
    expect(config.dryRun).toBe(true);
  });
});
