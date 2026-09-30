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
 * rewriting each import of a staged package to a relative path within
 * `srcDir`.
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

  // Each staged package's own name, as its siblings import it.
  const packages = new Map<string, string>();
  for (const dir of staged) {
    const name = await packageName(join(srcDir, dir));
    if (name) packages.set(name, dir);
  }
  if (packages.size === 0) return staged;

  for (const dir of staged) {
    const files = await glob("**/*.d.ts", {
      cwd: join(srcDir, dir),
      absolute: true,
    });
    for (const file of files) {
      const source = await readFile(file, "utf-8");
      const rewritten = rewriteSelfReferences(
        source,
        dirname(file),
        srcDir,
        packages
      );
      if (rewritten !== source) await writeFile(file, rewritten);
    }
  }
  return staged;
}

/** The `name` in a package's `package.json`; `undefined` when it has none. */
export async function packageName(pkgDir: string): Promise<string | undefined> {
  try {
    const { name } = JSON.parse(
      await readFile(join(pkgDir, "package.json"), "utf-8")
    );
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

// A module specifier in an import or export: `from '<spec>'` or `import('<spec>')`.
const SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;

/**
 * Rewrite each import in a declaration file at `fromDir` whose specifier is
 * exactly the name of a staged package (`packages`: name → directory) to the
 * relative path of `<srcDir>/<dir>/lib/index.js`. Every other import is left
 * as it is.
 */
export function rewriteSelfReferences(
  source: string,
  fromDir: string,
  srcDir: string,
  packages: ReadonlyMap<string, string>
): string {
  return source.replace(
    SPECIFIER,
    (match, lead: string, quote: string, spec: string) => {
      const dir = packages.get(spec);
      if (dir === undefined) return match;
      const target = relative(fromDir, resolve(srcDir, dir, "lib", "index.js"))
        .split(sep)
        .join("/");
      const path = target.startsWith(".") ? target : `./${target}`;
      return `${lead}${quote}${path}${quote}`;
    }
  );
}
