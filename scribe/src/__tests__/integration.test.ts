import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { rm, readFile, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";
import { discoverPackages } from "../discover.js";
import { analyzePackage } from "../analyze.js";
import { generate } from "../generate/index.js";

const FIXTURES_DIR = resolve(import.meta.dirname, "../__fixtures__");
const FIXTURES_INPUT = resolve(FIXTURES_DIR, "codegen-js");

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("integration: full pipeline", () => {
  describe("with bundling", () => {
    let tmpDir: string;
    let outputDir: string;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "scribe-test-"));
      outputDir = join(tmpDir, "dist");

      const config = await loadConfig({
        config: resolve(FIXTURES_DIR, "scribe.yaml"),
        input: FIXTURES_INPUT,
        output: outputDir,
      });
      const packages = await discoverPackages(config);
      const analyzed = await Promise.all(
        packages.map((pkg) => analyzePackage(pkg, config))
      );
      await generate(analyzed, config);
    }, 30_000);

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("produces codegen.js in output dir", async () => {
      expect(await fileExists(join(outputDir, "codegen.js"))).toBe(true);
    });

    it("produces index.js re-export in output dir", async () => {
      expect(await fileExists(join(outputDir, "index.js"))).toBe(true);
      const content = await readFile(join(outputDir, "index.js"), "utf-8");
      expect(content).toContain("export * from './codegen.js'");
    });

    it("produces version.js in output dir", async () => {
      expect(await fileExists(join(outputDir, "version.js"))).toBe(true);
      const content = await readFile(join(outputDir, "version.js"), "utf-8");
      expect(content).toContain("PACKAGE_VERSION");
    });

    it("produces index.d.ts in output dir", async () => {
      expect(await fileExists(join(outputDir, "index.d.ts"))).toBe(true);
    });

    it("produces version.d.ts in output dir", async () => {
      expect(await fileExists(join(outputDir, "version.d.ts"))).toBe(true);
    });

    it("codegen.js is valid ESM (has export statements)", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).toMatch(/^export /m);
    });

    it("codegen.js does not contain require() calls", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).not.toMatch(/\brequire\s*\(/);
    });

    it("codegen.js does not contain damlTypes.registerTemplate calls", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).not.toContain("damlTypes.registerTemplate");
    });

    it("codegen.js does not import @daml/ledger", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).not.toContain("@daml/ledger");
    });

    it("codegen.js uses namespace imports for externals", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      const jtvImport = content.match(/import .+ from "@mojotech\/json-type-validation"/);
      if (jtvImport) {
        expect(jtvImport[0]).toContain("import * as");
      }
      const typesImport = content.match(/import .+ from "@daml\/types"/);
      if (typesImport) {
        expect(typesImport[0]).toContain("import * as");
      }
    });

    it("codegen.js has no require$$N references (naming mismatch)", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).not.toMatch(/require\$\$\d+/);
    });

    it("codegen.js exports versionedRegistry", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).toContain("versionedRegistry");
    });

    it("codegen.js exports PACKAGE_VERSION", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).toContain("PACKAGE_VERSION");
    });

    it("codegen.js exports main module names", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).toContain("MyModule");
      expect(content).toContain("OtherModule");
    });

    it("codegen.js exports vendor alias (Splice_Amulet)", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).toContain("Splice_Amulet");
    });

    it("index.d.ts declares module re-exports", async () => {
      const content = await readFile(join(outputDir, "index.d.ts"), "utf-8");
      expect(content).toContain("export * as MyModule");
      expect(content).toContain("export * as OtherModule");
    });

    it("index.d.ts declares versionedRegistry", async () => {
      const content = await readFile(join(outputDir, "index.d.ts"), "utf-8");
      expect(content).toContain("versionedRegistry");
      expect(content).toContain("VersionedLookupResult");
    });

    it("index.d.ts declares vendor re-exports", async () => {
      const content = await readFile(join(outputDir, "index.d.ts"), "utf-8");
      expect(content).toContain("Splice_Amulet");
    });
  });

  describe("with bundling disabled", () => {
    let tmpDir: string;
    let outputDir: string;
    let srcDir: string;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "scribe-test-nobundle-"));
      outputDir = join(tmpDir, "dist");
      srcDir = join(tmpDir, "src"); // generate() creates src/ adjacent to output

      const config = await loadConfig({
        input: FIXTURES_INPUT,
        output: outputDir,
      });
      config.output.bundle = false;
      config.main.pattern = "my-project-*";
      // Clear any env-inherited version so directory-detected version flows through
      config.version = undefined;

      const packages = await discoverPackages(config);
      const analyzed = await Promise.all(
        packages.map((pkg) => analyzePackage(pkg, config))
      );
      await generate(analyzed, config);
    });

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("generates src/ staging files without bundling", async () => {
      expect(await fileExists(join(srcDir, "index.js"))).toBe(true);
      expect(await fileExists(join(srcDir, "index.d.ts"))).toBe(true);
      expect(await fileExists(join(srcDir, "version.js"))).toBe(true);
      expect(await fileExists(join(srcDir, "version.d.ts"))).toBe(true);
    });

    it("does not produce codegen.js in output (no bundling)", async () => {
      expect(await fileExists(join(outputDir, "codegen.js"))).toBe(false);
    });

    it("generates correct version in version.js", async () => {
      const content = await readFile(join(srcDir, "version.js"), "utf-8");
      expect(content).toContain("PACKAGE_VERSION");
      expect(content).toContain("0.1.0");
    });

    it("creates symlinks for input packages in src/", async () => {
      expect(await fileExists(join(srcDir, "my-project-0.1.0"))).toBe(true);
      expect(await fileExists(join(srcDir, "splice-amulet-0.1.9"))).toBe(true);
      expect(await fileExists(join(srcDir, "daml-prim-DA-Types-1.0.0"))).toBe(true);
    });

    it("generates registry code in index.js", async () => {
      const content = await readFile(join(srcDir, "index.js"), "utf-8");
      expect(content).toContain("versionedRegistry");
      expect(content).toContain("_registry");
    });
  });

  describe("dry run", () => {
    it("produces no output files in dry run mode", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "scribe-test-dry-"));
      const outputDir = join(tmpDir, "dist");

      try {
        const config = await loadConfig({
          input: FIXTURES_INPUT,
          output: outputDir,
          dryRun: true,
        });
        config.main.pattern = "my-project-*";

        const packages = await discoverPackages(config);
        const analyzed = await Promise.all(
          packages.map((pkg) => analyzePackage(pkg, config))
        );
        const result = await generate(analyzed, config);

        expect(result.files).toEqual([]);
        expect(await fileExists(outputDir)).toBe(false);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
