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
  const { build } = await import("vite");
  const { nodeResolve } = await import("@rollup/plugin-node-resolve");
  const commonjsMod = await import("@rollup/plugin-commonjs");
  const commonjs = (commonjsMod as any).default ?? commonjsMod;

  await mkdir(outputDir, { recursive: true });

  await build({
    configFile: false,
    logLevel: "warn",
    plugins: [
      resolveSelfReferences(srcDir),
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
        exclude: [
          "@mojotech/json-type-validation",
          "@daml/types",
          "@daml/ledger",
        ],
        ignoreDynamicRequires: false,
        ignoreGlobal: false,
      }),
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
        external: [
          "@mojotech/json-type-validation",
          "@daml/types",
          "@daml/ledger",
        ],
        output: {
          format: "es",
          exports: "named",
          preserveModules: false,
          inlineDynamicImports: true,
          manualChunks: undefined,
          dir: outputDir,
          entryFileNames: "codegen.js",
        },
        plugins: [fixImports()],
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

      // Strategy 2: Strip package prefix and try to resolve against srcDir.
      // Scoped: @scope/name/subpath -> skip first two segments
      // Unscoped: name/subpath -> skip first segment
      // Note: @rollup/plugin-commonjs may strip the '@' from scoped names
      // (e.g. @domain-verify/codegen/foo -> domain-verify/codegen/foo),
      // so we progressively try stripping more segments until a match is found.
      const parts = source.split("/");
      const startIdx = source.startsWith("@") ? 2 : 1;
      for (let i = startIdx; i < parts.length; i++) {
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
