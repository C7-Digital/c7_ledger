#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function generateSchemaModule(yamlPath: string, outputPath: string, exportName: string) {
  const yamlContent = readFileSync(yamlPath, "utf-8");

  // Escape the YAML content for TypeScript string literal
  const escapedContent = yamlContent
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");

  const tsContent = `// Auto-generated file - do not edit manually
// Generated from ${yamlPath}

export const ${exportName} = \`${escapedContent}\`;
`;

  writeFileSync(outputPath, tsContent, "utf-8");
  console.log(`✅ Generated ${outputPath} from ${yamlPath}`);
}

// Export the function for use in other scripts
export { generateSchemaModule };

// Only run directly if this file is executed as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  const projectRoot = join(__dirname, "..");
  const specsDir = join(projectRoot, "specs");
  const outputDir = join(projectRoot, "src", "generated");

  // Generate modules for both schemas
  generateSchemaModule(
    join(specsDir, "openapi_2025-08-31.yaml"),
    join(outputDir, "openapi-schema.ts"),
    "OPENAPI_SCHEMA"
  );

  generateSchemaModule(
    join(specsDir, "asyncapi_2025-08-31.yaml"),
    join(outputDir, "asyncapi-schema.ts"),
    "ASYNCAPI_SCHEMA"
  );

  console.log("🎉 All schema modules generated successfully!");
}
