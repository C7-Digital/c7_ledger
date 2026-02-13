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

    config() {
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
            "cross-fetch",
            "jose",
            "isomorphic-ws",
          ],
          esbuildOptions: {
            mainFields: ["module", "main"],
            resolveExtensions: [".mjs", ".js", ".ts", ".jsx", ".tsx", ".json"],
          },
        },
      };
    },
  };
}
