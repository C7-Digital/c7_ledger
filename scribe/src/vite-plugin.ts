/**
 * Companion Vite plugin for consumer apps that use @c7-digital/scribe output.
 *
 * Handles @daml/types and @mojotech/json-type-validation aliasing,
 * and configures optimizeDeps for DAML-related packages.
 */

import { resolve } from "node:path";

interface DamlCodegenPluginOptions {
  /** Override the path to node_modules (defaults to cwd) */
  nodeModulesPath?: string;
}

export function damlCodegenPlugin(options: DamlCodegenPluginOptions = {}) {
  const base = options.nodeModulesPath ?? process.cwd();

  return {
    name: "@c7-digital/scribe:daml-plugin",

    async config(this: { meta?: { viteVersion?: string } } | void) {
      // A Rolldown Vite (Vite 8, rolldown-vite) pre-bundles with Rolldown and
      // takes `rolldownOptions`; Vite 5 to 7 pre-bundle with esbuild and take
      // `esbuildOptions`. Vite 7 and later describe the running Vite in
      // `this.meta`; for Vite 5 and 6 the imported Vite tells.
      const meta = this ? this.meta : undefined;
      const rolldown =
        meta && meta.viteVersion
          ? "rolldownVersion" in meta
          : "rolldownVersion" in (await import("vite"));
      const mainFields = ["module", "main"];
      const extensions = [".mjs", ".js", ".ts", ".jsx", ".tsx", ".json"];
      return {
        resolve: {
          alias: {
            "@mojotech/json-type-validation": resolve(
              base,
              "node_modules/@mojotech/json-type-validation/dist/index.umd.js"
            ),
            "@daml/types": resolve(base, "node_modules/@daml/types"),
          },
        },
        optimizeDeps: {
          include: [
            "@mojotech/json-type-validation",
            "@daml/types",
            "@c7-digital/ledger",
            "@c7-digital/react",
            "eventemitter3",
            "jose",
            "isomorphic-ws",
          ],
          ...(rolldown
            ? { rolldownOptions: { resolve: { mainFields, extensions } } }
            : {
                esbuildOptions: {
                  mainFields,
                  resolveExtensions: extensions,
                },
              }),
        },
      };
    },
  };
}
