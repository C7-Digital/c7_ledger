import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  packageScope,
  rewriteSelfReferences,
  stagePackages,
} from "../generate/stage.js";

const TSC_BIN = resolve(import.meta.dirname, "../../node_modules/.bin/tsc");
const SCOPE = "@my-org/codegen";
const TIME_PKG = "daml-stdlib-DA-Time-Types-1.0.0";
const MAIN_PKG = "my-project-0.1.0";

const MAIN_DTS = [
  `import * as pkgTime from '${SCOPE}/${TIME_PKG}';`,
  `import * as other from '${SCOPE}/not-in-the-input';`,
  "export declare type Lock = { duration: pkgTime.RelTime };",
  "",
].join("\n");

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe("rewriteSelfReferences", () => {
  const known = new Set([TIME_PKG]);
  const scopes = new Set([SCOPE]);

  it("points a cross-package import at the staged package", () => {
    const out = rewriteSelfReferences(
      `import * as t from '${SCOPE}/${TIME_PKG}';`,
      "/stage/my-project-0.1.0/lib/M",
      "/stage",
      scopes,
      known
    );
    expect(out).toBe(
      `import * as t from '../../../${TIME_PKG}/lib/index.js';`
    );
  });

  it("keeps the quote style", () => {
    const out = rewriteSelfReferences(
      `import * as t from "${SCOPE}/${TIME_PKG}";`,
      "/stage/x/lib",
      "/stage",
      scopes,
      known
    );
    expect(out).toBe(`import * as t from "../../${TIME_PKG}/lib/index.js";`);
  });

  it("leaves imports of packages it did not stage, and other scopes, alone", () => {
    const source = [
      `import * as a from '${SCOPE}/not-in-the-input';`,
      `import * as b from '@other/codegen/${TIME_PKG}';`,
      "import * as damlTypes from '@daml/types';",
    ].join("\n");
    expect(
      rewriteSelfReferences(source, "/stage/x/lib", "/stage", scopes, known)
    ).toBe(source);
  });
});

describe("stagePackages", () => {
  let tmp: string;
  let input: string;
  let stage: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "scribe-stage-"));
    input = join(tmp, "codegen-js");
    stage = join(tmp, ".scribe");
    await put(
      join(input, TIME_PKG, "package.json"),
      JSON.stringify({ name: `${SCOPE}/${TIME_PKG}` })
    );
    await put(
      join(input, TIME_PKG, "lib", "index.d.ts"),
      "export declare type RelTime = { microseconds: string };\n"
    );
    await put(
      join(input, MAIN_PKG, "package.json"),
      JSON.stringify({ name: `${SCOPE}/${MAIN_PKG}` })
    );
    await put(join(input, MAIN_PKG, "lib", "M", "module.d.ts"), MAIN_DTS);
    await mkdir(stage);
    await stagePackages(input, stage);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads the scope from a package's name", async () => {
    expect(await packageScope(join(input, MAIN_PKG), MAIN_PKG)).toBe(SCOPE);
    expect(await packageScope(join(tmp, "missing"), "missing")).toBeUndefined();
  });

  it("rewrites the staged copy and leaves the input as it was", async () => {
    const staged = await readFile(
      join(stage, MAIN_PKG, "lib", "M", "module.d.ts"),
      "utf-8"
    );
    expect(staged).toContain(`'../../../${TIME_PKG}/lib/index.js'`);
    expect(staged).toContain(`'${SCOPE}/not-in-the-input'`);
    expect(
      await readFile(join(input, MAIN_PKG, "lib", "M", "module.d.ts"), "utf-8")
    ).toBe(MAIN_DTS);
  });

  it("gives a consumer the real cross-package type, not any", async () => {
    await put(
      join(tmp, "consumer.ts"),
      [
        `import type { Lock } from "./.scribe/${MAIN_PKG}/lib/M/module.js";`,
        'export const ok: Lock = { duration: { microseconds: "1" } };',
        "// Unused (an error) if `duration` resolved to `any`.",
        "// @ts-expect-error a number is not a RelTime",
        "export const bad: Lock = { duration: 5 };",
        "",
      ].join("\n")
    );
    await put(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          module: "es2022",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["consumer.ts"],
      })
    );
    expect(() =>
      execSync(`${TSC_BIN} -p tsconfig.json`, { cwd: tmp, stdio: "pipe" })
    ).not.toThrow();
  });
});
