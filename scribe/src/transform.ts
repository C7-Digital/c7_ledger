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
 * Vite plugin to resolve self-referencing package imports.
 *
 * Raw codegen .d.ts files reference the package by its own npm name, e.g.:
 *   require('@domain-verify/codegen/daml-prim-DA-Types-1.0.0')
 *
 * The subpath after the package name corresponds to a directory in srcDir.
 * We resolve these to local paths: srcDir/<subpath>/lib/index.js
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

      // Strategy 2: Strip scoped package prefix (@scope/name/subpath -> subpath)
      // Handles: @domain-verify/codegen/daml-prim-DA-Types-1.0.0
      let subpath: string | undefined;
      if (source.startsWith("@")) {
        // @scope/name/subpath -> skip first two segments
        const parts = source.split("/");
        if (parts.length > 2) {
          subpath = parts.slice(2).join("/");
        }
      } else if (source.includes("/")) {
        // unscoped-name/subpath -> skip first segment
        const parts = source.split("/");
        if (parts.length > 1) {
          subpath = parts.slice(1).join("/");
        }
      }

      if (subpath) {
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
          chunk.code = chunk.code
            .replace(
              'import require$$0 from "@mojotech/json-type-validation";',
              'import * as require$$0 from "@mojotech/json-type-validation";'
            )
            .replace(
              'import require$$1 from "@daml/types";',
              'import * as require$$1 from "@daml/types";'
            )
            .replace(/import "@daml\/ledger";\n?/g, "")
            .replace(/^.*damlTypes\.registerTemplate.*$/gm, "");

          // Discard source maps since we're modifying code
          chunk.map = null;
        }
      }
    },
  };
}
