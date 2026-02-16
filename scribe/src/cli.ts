#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { discoverPackages } from "./discover.js";
import { analyzePackage } from "./analyze.js";
import { generate } from "./generate/index.js";

export interface RunOptions {
  input?: string;
  config?: string;
  version?: string;
  output?: string;
  dryRun?: boolean;
}

export async function run(opts: RunOptions = {}): Promise<void> {
  const config = await loadConfig(opts);
  const packages = await discoverPackages(config);

  const analyzed = await Promise.all(
    packages.map((pkg) => analyzePackage(pkg, config))
  );

  await generate(analyzed, config);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: "string", short: "i" },
      config: { type: "string", short: "c" },
      version: { type: "string", short: "v" },
      output: { type: "string", short: "o" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });

  await run({
    input: values.input,
    config: values.config,
    version: values.version,
    output: values.output,
    dryRun: values["dry-run"],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
