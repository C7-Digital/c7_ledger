import { describe, it, expect } from "vitest";
import { damlCodegenPlugin } from "../vite-plugin.js";

describe("damlCodegenPlugin", () => {
  it("gives the installed Vite the pre-bundle options that it reads", async () => {
    const vite = await import("vite");
    const config = await vite.resolveConfig(
      {
        configFile: false,
        logLevel: "silent",
        plugins: [damlCodegenPlugin()],
      },
      "serve"
    );
    const optimizeDeps = config.optimizeDeps as {
      include?: string[];
      rolldownOptions?: { resolve?: { mainFields?: string[] } };
      esbuildOptions?: { mainFields?: string[] };
    };
    expect(optimizeDeps.include).toContain("@daml/types");
    const mainFields =
      "rolldownVersion" in vite
        ? optimizeDeps.rolldownOptions?.resolve?.mainFields
        : optimizeDeps.esbuildOptions?.mainFields;
    expect(mainFields).toEqual(["module", "main"]);
  });
});
