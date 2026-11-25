import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";

/**
 * Bundle the generated src/index.js into a single ESM file using Vite/Rollup.
 *
 * This handles:
 * - CJS -> ESM conversion (raw codegen uses require/module.exports)
 * - Self-reference resolution (package imports -> local paths)
 * - Import fixups (default -> namespace for @mojotech/json-type-validation, @daml/types)
 * - Stripping @daml/ledger side-effect imports
 * - Stripping damlTypes.registerTemplate() calls
 */
export async function bundle(
  srcDir: string,
  outputDir: string
): Promise<void> {
  // Dynamic import so vite is only required when bundling
  const vite = await import("vite");
  // Vite 8 (and rolldown-vite) builds with Rolldown, which resolves modules
  // and converts CJS to ESM itself. The Rollup plugins do not finish under
  // Rolldown. A Rolldown Vite exports `rolldownVersion`.
  const rolldown = "rolldownVersion" in vite;

  await mkdir(outputDir, { recursive: true });

  await vite.build({
    configFile: false,
    logLevel: "warn",
    plugins: [
      resolveSelfReferences(srcDir),
      ...(rolldown ? [] : await rollupCjsPlugins()),
    ],
    build: {
      sourcemap: false,
      minify: false,
      write: true,
      lib: {
        entry: resolve(srcDir, "index.js"),
        name: "codegen",
        formats: ["es"],
        fileName: "codegen",
      },
      rollupOptions: {
        // Under Rolldown the external-imports plugin owns these packages.
        external: rolldown ? [] : [...EXTERNALS],
        output: {
          format: "es",
          exports: "named",
          preserveModules: false,
          // One output file. Rolldown (Vite 8) names the option `codeSplitting`.
          ...(rolldown ? { codeSplitting: false } : { inlineDynamicImports: true }),
          manualChunks: undefined,
          dir: outputDir,
          entryFileNames: "codegen.js",
        },
        plugins: [
          ...(rolldown ? [rolldownExternalImports(vite)] : []),
          fixImports(),
        ],
      },
    },
  });

  // Create compatibility re-exports
  await writeFile(
    resolve(outputDir, "index.js"),
    [
      "// Re-export everything from codegen.js",
      "export * from './codegen.js';",
      "",
    ].join("\n")
  );

  await writeFile(
    resolve(outputDir, "version.js"),
    "export { PACKAGE_VERSION } from './codegen.js';\n"
  );
}

/** The packages that the bundle imports and does not contain. */
const EXTERNALS = [
  "@mojotech/json-type-validation",
  "@daml/types",
  "@daml/ledger",
] as const;

/**
 * Rolldown keeps a `require()` of an external package as a call that throws
 * in an ES module. This plugin makes each one an `import`.
 */
function rolldownExternalImports(vite: typeof import("vite")) {
  if (typeof vite.esmExternalRequirePlugin !== "function") {
    throw new Error(
      `scribe: this Rolldown Vite (${vite.version}) has no esmExternalRequirePlugin; use Vite 8 or later`
    );
  }
  return vite.esmExternalRequirePlugin({ external: [...EXTERNALS] });
}

/** Module resolution and the CJS -> ESM conversion for Vite 5 to 7 (Rollup). */
async function rollupCjsPlugins() {
  const { nodeResolve } = await import("@rollup/plugin-node-resolve");
  const commonjsMod = await import("@rollup/plugin-commonjs");
  const commonjs = (commonjsMod as any).default ?? commonjsMod;
  return [
    nodeResolve({
      browser: true,
      preferBuiltins: true,
      mainFields: ["module", "main"],
      extensions: [".js", ".json"],
    }),
    commonjs({
      include: ["**/*.js"],
      extensions: [".js", ".cjs"],
      requireReturnsDefault: "namespace",
      transformMixedEsModules: true,
      exclude: [...EXTERNALS],
      ignoreDynamicRequires: false,
      ignoreGlobal: false,
    }),
  ];
}

/**
 * Rollup plugin to resolve cross-package imports within the codegen output.
 *
 * Each raw codegen package imports its dependencies (e.g. daml-prim, daml-stdlib)
 * using the consumer's npm package name as a prefix:
 *   require('@mypackage/codegen/daml-prim-DA-Types-1.0.0')
 *
 * At bundle time these aren't real npm packages — they're sibling directories
 * in the staging area. This plugin strips the package prefix and resolves
 * the subpath to a local directory: srcDir/<subpath>/lib/index.js
 */
function resolveSelfReferences(srcDir: string) {
  return {
    name: "scribe:resolve-self-references",
    resolveId(source: string) {
      // Strategy 1: If the source directly matches a directory in srcDir
      // (e.g., relative imports that got resolved to a package name)
      const direct = resolve(srcDir, source);
      if (existsSync(direct)) {
        const withLib = resolve(direct, "lib", "index.js");
        if (existsSync(withLib)) return withLib;
      }

      // Strategy 2: Strip the package prefix and try to resolve against srcDir.
      // The prefix is one or more leading segments: `@scope/name/subpath`,
      // `name/subpath`, or the default codegen-js name `@daml.js/<package>`.
      // @rollup/plugin-commonjs may strip the '@' from scoped names
      // (e.g. @my-org/codegen/foo -> my-org/codegen/foo), so we strip one
      // more segment at a time until a match is found.
      const parts = source.split("/");
      for (let i = 1; i < parts.length; i++) {
        const subpath = parts.slice(i).join("/");
        const resolvedDir = resolve(srcDir, subpath);
        if (existsSync(resolvedDir)) {
          const withLib = resolve(resolvedDir, "lib", "index.js");
          if (existsSync(withLib)) return withLib;

          const withIndex = resolve(resolvedDir, "index.js");
          if (existsSync(withIndex)) return withIndex;
        }
      }

      return null;
    },
  };
}

/**
 * Rollup plugin to fix imports in the bundled output.
 *
 * The raw codegen uses patterns that don't survive CJS->ESM conversion cleanly:
 * - @mojotech/json-type-validation is imported as default but should be namespace
 * - @daml/types is imported as default but should be namespace
 * - @daml/ledger is imported as a side-effect (not needed)
 * - damlTypes.registerTemplate() calls should be stripped
 */
function fixImports() {
  return {
    name: "scribe:fix-imports",
    generateBundle(
      _options: unknown,
      bundle: Record<string, { type: string; code?: string; map?: unknown }>
    ) {
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk?.type === "chunk" && chunk.code) {
          let code = chunk.code;

          // Fix default -> namespace imports for external modules.
          // Rollup variable names vary across versions (require$0, require$$0, etc.)
          // so we match any variable name generically.
          code = code.replace(
            /import ([\w$]+) from "(@mojotech\/json-type-validation|@daml\/types)";/g,
            'import * as $1 from "$2";'
          );

          // The commonjs plugin's CJS interop code may use a different naming
          // convention (require$$N) than the Rollup import variables (require$N).
          // Normalize double-$ references to match the actual import names.
          code = code.replace(
            /require\$\$(\d+)/g,
            (_, n) => `require$${n}`
          );

          // Remove @daml/ledger side-effect imports
          code = code.replace(/import "@daml\/ledger";\n?/g, "");

          // Strip global registerTemplate calls
          code = code.replace(/^.*damlTypes\.registerTemplate.*$/gm, "");

          chunk.code = code;
          // Discard source maps since we're modifying code
          chunk.map = null;
        }
      }
    },
  };
}
