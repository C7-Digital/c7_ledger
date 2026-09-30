import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { glob } from "glob";

/**
 * Stage the input packages into `srcDir` so their type declarations resolve.
 *
 * Daml codegen names each package `<scope>/<dir>` (e.g.
 * `@my-org/codegen/daml-stdlib-DA-Time-Types-1.0.0`, or `@daml.js/...` without
 * `-s`) and imports its dependencies by that name. No `node_modules` serves
 * those names, so TypeScript cannot resolve them and every cross-package type
 * (`RelTime`, `NonEmpty`, `Set`, ...) silently becomes `any`. The bundle maps
 * the same imports back to local packages at build time
 * (`resolveSelfReferences`); this does the same for the `.d.ts` files, by
 * rewriting each cross-package import to a relative path within `srcDir`.
 *
 * Packages are copied rather than symlinked, so the rewrite never touches the
 * input and TypeScript never leaves `srcDir` through a link's real path.
 * Returns the staged directory names.
 */
export async function stagePackages(
  inputDir: string,
  srcDir: string
): Promise<string[]> {
  const staged: string[] = [];
  for (const entry of await readdir(inputDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await cp(join(inputDir, entry.name), join(srcDir, entry.name), {
      recursive: true,
      dereference: true,
    });
    staged.push(entry.name);
  }

  const scopes = new Set<string>();
  for (const name of staged) {
    const scope = await packageScope(join(srcDir, name), name);
    if (scope) scopes.add(scope);
  }
  if (scopes.size === 0) return staged;

  const known = new Set(staged);
  for (const name of staged) {
    const files = await glob("**/*.d.ts", {
      cwd: join(srcDir, name),
      absolute: true,
    });
    for (const file of files) {
      const source = await readFile(file, "utf-8");
      const rewritten = rewriteSelfReferences(
        source,
        dirname(file),
        srcDir,
        scopes,
        known
      );
      if (rewritten !== source) await writeFile(file, rewritten);
    }
  }
  return staged;
}

/**
 * The name prefix codegen gave a package: `@my-org/codegen` for a package
 * named `@my-org/codegen/<dir>`. `undefined` when its `package.json` is
 * missing or its name does not end in its directory name.
 */
export async function packageScope(
  pkgDir: string,
  dirName: string
): Promise<string | undefined> {
  let name: unknown;
  try {
    name = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf-8")).name;
  } catch {
    return undefined;
  }
  const suffix = `/${dirName}`;
  return typeof name === "string" && name.endsWith(suffix)
    ? name.slice(0, -suffix.length)
    : undefined;
}

/**
 * Rewrite imports of `<scope>/<pkg>` in a declaration file at `fromDir` to the
 * relative path of `<srcDir>/<pkg>/lib/index.js`. Only packages in `known` are
 * rewritten; any other import is left as it is.
 */
export function rewriteSelfReferences(
  source: string,
  fromDir: string,
  srcDir: string,
  scopes: ReadonlySet<string>,
  known: ReadonlySet<string>
): string {
  let out = source;
  for (const scope of scopes) {
    const pattern = new RegExp(`(['"])${escapeRegExp(scope)}/([^'"/]+)\\1`, "g");
    out = out.replace(pattern, (match, quote: string, pkg: string) => {
      if (!known.has(pkg)) return match;
      const target = relative(fromDir, resolve(srcDir, pkg, "lib", "index.js"))
        .split(sep)
        .join("/");
      return `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`;
    });
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
