import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import type { RunOptions } from "./cli.js";

// --- Zod schemas ---

const TemplateListSchema = z.array(z.string()).optional();

const ModuleConfigSchema = z.object({
  alias: z.string().optional(),
  templates: TemplateListSchema,
  interfaces: z.array(z.string()).optional(),
});

const MainConfigSchema = z.object({
  pattern: z.string().optional(),
  modules: z.record(z.string(), ModuleConfigSchema).optional(),
});

const VendorPackageConfigSchema = z.object({
  alias: z.string().optional(),
  modules: z.record(z.string(), ModuleConfigSchema).optional(),
});

const CompatVersionSchema = z.object({
  hash: z.string(),
  version: z.string(),
});

const CompatPackageSchema = z.object({
  versions: z.array(CompatVersionSchema).default([]),
});

const CompatConfigSchema = z.record(z.string(), CompatPackageSchema);

const OutputConfigSchema = z.object({
  dir: z.string().default("dist"),
  bundle: z.boolean().default(true),
});

const ConfigFileSchema = z.object({
  schema: z.literal("1.0"),
  input: z.string().optional(),
  output: OutputConfigSchema.optional(),
  main: MainConfigSchema.optional(),
  vendor: z.record(z.string(), VendorPackageConfigSchema).optional(),
  compat: CompatConfigSchema.optional(),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

// --- Resolved config (after merging CLI opts + file + defaults) ---

export type ModuleOverride = z.infer<typeof ModuleConfigSchema>;
export type VendorOverride = z.infer<typeof VendorPackageConfigSchema>;

export interface ResolvedConfig {
  input: string;
  output: { dir: string; bundle: boolean };
  main: {
    pattern?: string;
    modules?: Record<string, ModuleOverride>;
  };
  vendor?: Record<string, VendorOverride>;
  compat: Record<string, { versions: Array<{ hash: string; version: string }> }>;
  version?: string;
  dryRun: boolean;
}

export async function loadConfig(opts: RunOptions): Promise<ResolvedConfig> {
  let file: ConfigFile | undefined;

  if (opts.config) {
    const raw = await readFile(resolve(opts.config), "utf-8");
    const parsed = YAML.parse(raw);
    file = ConfigFileSchema.parse(parsed);
  }

  const input = opts.input ?? file?.input ?? "./codegen/js";
  const outputDir = opts.output ?? file?.output?.dir ?? "dist";
  const bundle = file?.output?.bundle ?? true;

  return {
    input: resolve(input),
    output: { dir: resolve(outputDir), bundle },
    main: { pattern: file?.main?.pattern, modules: file?.main?.modules },
    vendor: file?.vendor,
    compat: file?.compat ?? {},
    version: opts.version ?? process.env["DAR_VERSION"],
    dryRun: opts.dryRun ?? false,
  };
}
