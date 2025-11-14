#!/usr/bin/env node

/**
 * Generate TypeScript types from AsyncAPI specification by converting to OpenAPI format
 *
 * This script converts the AsyncAPI YAML to OpenAPI format and uses the existing
 * openapi-typescript generator to create types. Much simpler than custom schema parsing.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const __dirname = process.cwd();

async function generateAsyncApiTypes(specPath?: string): Promise<void> {
  try {
    // Get spec path from parameter or command line argument
    const asyncApiSpecPath = specPath || process.argv[2];
    if (!asyncApiSpecPath) {
      console.error("Usage: node generate-asyncapi-types.ts <path-to-asyncapi-spec>");
      process.exit(1);
    }

    // Read the AsyncAPI specification
    const asyncApiPath = path.resolve(asyncApiSpecPath);
    const asyncApiContent = fs.readFileSync(asyncApiPath, "utf8");
    const asyncApiSpec = yaml.parse(asyncApiContent);

    // Convert AsyncAPI to OpenAPI format by changing the header
    const openApiSpec = {
      ...asyncApiSpec,
      openapi: "3.0.3",
      info: asyncApiSpec.info,
      components: asyncApiSpec.components,
      // Remove AsyncAPI-specific fields
      asyncapi: undefined,
      channels: undefined,
      operations: undefined,
      // Add empty paths since OpenAPI requires it
      paths: {},
    };

    // Clean up undefined properties
    delete openApiSpec.asyncapi;
    delete openApiSpec.channels;
    delete openApiSpec.operations;

    // Create temporary OpenAPI file
    const tempOpenApiPath = path.join(__dirname, "temp-asyncapi-as-openapi.yaml");
    fs.writeFileSync(tempOpenApiPath, yaml.stringify(openApiSpec));

    console.log(`📝 Created temporary OpenAPI file: ${tempOpenApiPath}`);
    console.log(`🔄 Generating types using openapi-typescript...`);

    // Use the existing openapi-typescript generator
    const outputPath = path.join(__dirname, "src", "generated", "async-api.ts");
    const generateCommand = `pnpm exec openapi-typescript "${tempOpenApiPath}" --output "${outputPath}"`;

    const { stdout, stderr } = await execAsync(generateCommand);

    if (stderr && !stderr.includes("Warning")) {
      console.warn("openapi-typescript warnings:", stderr);
    }

    if (stdout) {
      console.log("openapi-typescript output:", stdout);
    }

    // Now add channels interface for WebSocket connections
    console.log(`🔄 Adding channels interface for WebSocket connections...`);

    // Parse the original AsyncAPI spec to extract channels
    let channelsInterface = "\nexport interface channels {\n";

    if (asyncApiSpec.channels) {
      for (const [channelPath, channelData] of Object.entries(asyncApiSpec.channels)) {
        const channel = channelData as any;
        channelsInterface += `  "${channelPath}": {\n`;

        // Add description if available
        if (channel.description) {
          channelsInterface += `    /** @description ${channel.description} */\n`;
        }

        // Add operations (publish/subscribe)
        if (channel.publish) {
          channelsInterface += `    publish: {\n`;
          if (channel.publish.description) {
            channelsInterface += `      /** @description ${channel.publish.description} */\n`;
          }
          if (channel.publish.message) {
            const messageRef = channel.publish.message.$ref || channel.publish.message;
            const messageName =
              typeof messageRef === "string" && messageRef.includes("#/")
                ? messageRef.replace("#/components/messages/", "")
                : messageRef;
            channelsInterface += `      message: components["schemas"]["${messageName}"];\n`;
          }
          channelsInterface += `    };\n`;
        }

        if (channel.subscribe) {
          channelsInterface += `    subscribe: {\n`;
          if (channel.subscribe.description) {
            channelsInterface += `      /** @description ${channel.subscribe.description} */\n`;
          }
          if (channel.subscribe.message) {
            const messageRef = channel.subscribe.message.$ref || channel.subscribe.message;
            const messageName =
              typeof messageRef === "string" && messageRef.includes("#/")
                ? messageRef.replace("#/components/messages/", "")
                : messageRef;
            channelsInterface += `      message: components["schemas"]["${messageName}"];\n`;
          }
          channelsInterface += `    };\n`;
        }

        channelsInterface += `  };\n`;
      }
    }

    channelsInterface += "}\n";

    // Append channels interface to the generated file
    const generatedContent = fs.readFileSync(outputPath, "utf8");
    const brandedContent = generatedContent + channelsInterface;
    fs.writeFileSync(outputPath, brandedContent);

    // Clean up temporary file
    fs.unlinkSync(tempOpenApiPath);
    console.log(`🧹 Cleaned up temporary file`);

    console.log(`✅ Generated AsyncAPI types with channels interface: ${outputPath}`);
  } catch (error) {
    console.error("❌ Error generating AsyncAPI types:", (error as Error).message);

    // Clean up temporary file on error
    const tempOpenApiPath = path.join(__dirname, "temp-asyncapi-as-openapi.yaml");
    if (fs.existsSync(tempOpenApiPath)) {
      fs.unlinkSync(tempOpenApiPath);
      console.log(`🧹 Cleaned up temporary file after error`);
    }

    process.exit(1);
  }
}

// Export the function for use in other scripts
export { generateAsyncApiTypes };

// Only run directly if this file is executed as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  generateAsyncApiTypes();
}
