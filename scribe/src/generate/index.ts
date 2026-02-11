import type { AnalyzedPackage } from "../analyze.js";
import type { ResolvedConfig } from "../config.js";

export async function generate(
  _packages: AnalyzedPackage[],
  _config: ResolvedConfig
): Promise<void> {
  // TODO: implement generation pipeline
  console.log("generate: not yet implemented");
}
