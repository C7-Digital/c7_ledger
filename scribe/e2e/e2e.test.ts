import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, join } from "node:path";
import {
  rm,
  readFile,
  mkdtemp,
  mkdir,
  cp,
  symlink,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { execSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { discoverPackages } from "../src/discover.js";
import { analyzePackage } from "../src/analyze.js";
import { generate } from "../src/generate/index.js";

const SCRIBE_DIR = resolve(import.meta.dirname, "..");
const MONOREPO_ROOT = resolve(SCRIBE_DIR, "..");
const E2E_DAML_DIR = resolve(import.meta.dirname, "daml");
const TSC_BIN = join(SCRIBE_DIR, "node_modules", ".bin", "tsc");

interface DamlToolchain {
  bin: string;
  /** Command to compile a DAR */
  build: string;
  /** Command to run JS codegen — dpm uses "codegen-js", daml uses "codegen js" */
  codegenJs: string;
}

/** Detect the Daml toolchain CLI — prefer dpm over the deprecated daml assistant. */
function detectDamlCli(): DamlToolchain | undefined {
  // Try dpm first (replacement for daml assistant, removed in SDK 3.5)
  const dpmPaths = ["dpm", join(homedir(), ".dpm", "bin", "dpm")];
  for (const bin of dpmPaths) {
    try {
      execSync(`${bin} version`, { stdio: "pipe" });
      return { bin, build: `${bin} build`, codegenJs: `${bin} codegen-js` };
    } catch {
      // not found at this path
    }
  }
  // Fall back to legacy daml assistant
  try {
    execSync("daml version", { stdio: "pipe" });
    return { bin: "daml", build: "daml build", codegenJs: "daml codegen js" };
  } catch {
    return undefined;
  }
}

const DAML_CLI = detectDamlCli();

if (!DAML_CLI) {
  console.warn("⚠ Neither dpm nor daml CLI found — skipping e2e tests");
}

describe.skipIf(!DAML_CLI)(
  "e2e: daml codegen → scribe → consumer",
  () => {
    let tmpDir: string;
    let codegenDir: string;
    let outputDir: string;
    let consumerDir: string;
    let codegenEntries: string[];

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "scribe-e2e-"));
      codegenDir = join(tmpDir, "codegen", "js");
      outputDir = join(tmpDir, "dist");
      consumerDir = join(tmpDir, "consumer");

      // 1. Copy daml project to temp dir (keeps repo clean of .daml/ build artifacts)
      const damlDir = join(tmpDir, "daml");
      await cp(E2E_DAML_DIR, damlDir, { recursive: true });

      // 2. Build DAR (dpm or daml)
      execSync(DAML_CLI!.build, {
        cwd: damlDir,
        stdio: "pipe",
        timeout: 120_000,
      });

      // 3. Codegen JS (dpm or daml)
      // NOTE: DAR filename derives from name + version in e2e/daml/daml.yaml
      const darPath = join(
        damlDir,
        ".daml",
        "dist",
        "scribe-e2e-test-0.1.0.dar"
      );
      await mkdir(codegenDir, { recursive: true });
      execSync(`${DAML_CLI!.codegenJs} ${darPath} -o ${codegenDir}`, {
        stdio: "pipe",
        timeout: 120_000,
      });

      // 4. Record what codegen produced
      codegenEntries = await readdir(codegenDir);

      // 5. Run scribe pipeline
      const config = await loadConfig({ input: codegenDir, output: outputDir });
      const packages = await discoverPackages(config);
      const analyzed = await Promise.all(
        packages.map((pkg) => analyzePackage(pkg, config))
      );
      await generate(analyzed, config);

      // 6. Set up node_modules at tmpDir level for module resolution
      //    (both tsc and vite need to resolve @daml/types, etc.)
      const nmBase = join(tmpDir, "node_modules");
      await mkdir(join(nmBase, "@daml"), { recursive: true });
      await mkdir(join(nmBase, "@mojotech"), { recursive: true });
      await mkdir(join(nmBase, "@c7-digital"), { recursive: true });

      await symlink(
        join(MONOREPO_ROOT, "ledger", "node_modules", "@daml", "types"),
        join(nmBase, "@daml", "types")
      );
      await symlink(
        join(
          MONOREPO_ROOT,
          "node_modules",
          ".pnpm",
          "@mojotech+json-type-validation@3.1.0",
          "node_modules",
          "@mojotech",
          "json-type-validation"
        ),
        join(nmBase, "@mojotech", "json-type-validation")
      );
      await symlink(
        join(MONOREPO_ROOT, "ledger"),
        join(nmBase, "@c7-digital", "ledger")
      );

      // 7. Set up consumer project
      await mkdir(consumerDir, { recursive: true });

      await writeFile(
        join(consumerDir, "consumer.ts"),
        [
          "// Consumer verification: imports from scribe output",
          'import { TestModel, versionedRegistry, PACKAGE_VERSION } from "../.scribe/index.js";',
          "",
          "// Verify template shape",
          "const asset = TestModel.Asset;",
          "const templateId: string = asset.templateId;",
          "",
          "// Verify registry works",
          "const lookup = versionedRegistry(templateId);",
          "",
          "// Verify version",
          "const ver: string = PACKAGE_VERSION;",
          "",
          "// Verify ledger type compatibility",
          'import type { Ledger, LedgerOptions } from "@c7-digital/ledger";',
          "",
        ].join("\n")
      );

      await writeFile(
        join(consumerDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2020",
              module: "es2022",
              moduleResolution: "bundler",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
            },
            include: ["consumer.ts"],
          },
          null,
          2
        )
      );
    });

    afterAll(async () => {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("daml codegen produces expected package directories", () => {
      const mainPkg = codegenEntries.find((e) =>
        e.startsWith("scribe-e2e-test-")
      );
      expect(mainPkg).toBeDefined();

      // Should also produce some stdlib packages
      const stdlibPkgs = codegenEntries.filter(
        (e) => e.startsWith("daml-prim-") || e.startsWith("daml-stdlib-")
      );
      expect(stdlibPkgs.length).toBeGreaterThan(0);
    });

    it("scribe produces bundled output (codegen.js, index.js, index.d.ts)", async () => {
      const distEntries = await readdir(outputDir);
      expect(distEntries).toContain("codegen.js");
      expect(distEntries).toContain("index.js");
      expect(distEntries).toContain("index.d.ts");
    });

    it("scribe output is valid ESM", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).toMatch(/^export /m);
      expect(content).not.toMatch(/\brequire\s*\(/);
    });

    it("scribe output exports versionedRegistry and PACKAGE_VERSION", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).toContain("versionedRegistry");
      expect(content).toContain("PACKAGE_VERSION");
    });

    it("scribe output exports TestModel module", async () => {
      const content = await readFile(join(outputDir, "codegen.js"), "utf-8");
      expect(content).toContain("TestModel");
    });

    it("consumer type-checks with tsc", () => {
      try {
        execSync(`${TSC_BIN} -p tsconfig.json --noEmit`, {
          cwd: consumerDir,
          stdio: "pipe",
          timeout: 30_000,
        });
      } catch (e: unknown) {
        const err = e as { stderr?: Buffer; stdout?: Buffer; message: string };
        const output =
          err.stderr?.toString() || err.stdout?.toString() || err.message;
        throw new Error(`tsc type-check failed:\n${output}`);
      }
    });

    it("consumer bundles with vite", async () => {
      const { build } = await import("vite");
      const { damlCodegenPlugin } = await import("../src/vite-plugin.js");

      await build({
        root: consumerDir,
        plugins: [damlCodegenPlugin({ nodeModulesPath: tmpDir })],
        build: {
          lib: {
            entry: join(consumerDir, "consumer.ts"),
            formats: ["es"],
            fileName: "consumer",
          },
          outDir: join(consumerDir, "vite-out"),
          rollupOptions: {
            external: ["@c7-digital/ledger"],
          },
        },
        logLevel: "silent",
      });

      // Verify vite produced output
      const viteOutput = await readdir(join(consumerDir, "vite-out"));
      expect(viteOutput.length).toBeGreaterThan(0);
    });
  }
);
