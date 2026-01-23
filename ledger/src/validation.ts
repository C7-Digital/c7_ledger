/**
 * Runtime validation utilities for API responses using JSON Schema validation
 *
 * Uses embedded schema strings instead of file system access for browser compatibility.
 */
import * as Ajv from "ajv";
import { logger } from "./logger";
// Dynamic imports for tree shaking - yaml and schemas only loaded when validation is used

export type ValidationMode = "throwOnError" | "logErrors";

interface JsonSchemaProperty {
  type?: string | string[];
  $ref?: string;
  anyOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
  oneOf?: JsonSchemaProperty[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  items?: JsonSchemaProperty;
  [key: string]: unknown;
}

type JsonSchemaOrArray = JsonSchemaProperty | JsonSchemaProperty[];

export class SchemaValidator {
  private ajv?: InstanceType<typeof Ajv.default>;
  private schemaCount = 0;
  private instanceId: string;
  private schemaReady: Promise<void>;
  private validation?: ValidationMode;

  constructor(schemaType: "openapi" | "asyncapi" = "openapi", validation?: ValidationMode) {
    this.instanceId = Math.random().toString(36).substring(2, 8);

    this.validation = validation;
    if (!this.validation) {
      logger.debug(
        `Validation disabled for instance ${this.instanceId} - schemas not loaded (validation mode: undefined)`
      );
      this.schemaReady = Promise.resolve();
      return;
    }

    this.ajv = new Ajv.default({
      allErrors: true,
      verbose: true,
      addUsedSchema: false, // Don't add schemas automatically
    });

    logger.log(`Creating SchemaValidator instance ${this.instanceId} for ${schemaType} schema`);

    // Add support for Canton/OpenAPI formats
    this.addCustomFormats();

    // Load schemas asynchronously to enable tree shaking
    this.schemaReady = this.loadSchemasAsync(schemaType);
  }

  private async loadSchemasAsync(schemaType: "openapi" | "asyncapi"): Promise<void> {
    try {
      switch (schemaType) {
        case "openapi":
          const { OPENAPI_SCHEMA } = await import("./generated/openapi-schema");
          await this.loadSchemasFromContent(OPENAPI_SCHEMA);
          break;
        case "asyncapi":
          const { ASYNCAPI_SCHEMA } = await import("./generated/asyncapi-schema");
          await this.loadSchemasFromContent(ASYNCAPI_SCHEMA);
          break;
      }
    } catch (error) {
      logger.warn(` Failed to load ${schemaType} schema for validation:`, error);
    }
  }

  /**
   * Add custom format validators for Canton API types
   */
  private addCustomFormats(): void {
    if (!this.ajv) return;

    // int64 format - just validate it's a valid number or string that can be parsed as number
    this.ajv.addFormat("int64", {
      type: "number",
      validate: (data: unknown) => {
        if (typeof data === "number") {
          return Number.isInteger(data);
        }
        if (typeof data === "string") {
          const num = parseInt(data, 10);
          return !isNaN(num) && num.toString() === data;
        }
        return false;
      },
    });

    // int32 format
    this.ajv.addFormat("int32", {
      type: "number",
      validate: (data: unknown) => {
        if (typeof data === "number") {
          return Number.isInteger(data) && data >= -2147483648 && data <= 2147483647;
        }
        return false;
      },
    });

    // date-time format (if not already supported)
    this.ajv.addFormat("date-time", {
      type: "string",
      validate: (dateTimeString: unknown) => {
        if (typeof dateTimeString !== "string") return false;
        return !isNaN(Date.parse(dateTimeString));
      },
    });
  }

  /**
   * Helper function to handle errors based on the validation mode
   */
  private handleError(message: string, error?: unknown): never | void {
    if (this.validation === "logErrors") {
      logger.warn(`Warning: ${message}`, error);
      return;
    } else {
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * Transform schema to allow null values for non-required fields
   * This handles the common OpenAPI pattern where optional fields can be null
   */
  private makeOptionalFieldsNullable(schema: JsonSchemaOrArray): JsonSchemaOrArray {
    if (!schema || typeof schema !== "object") return schema;

    // Handle arrays - recursively transform each element
    if (Array.isArray(schema)) {
      return schema.map((item) => this.makeOptionalFieldsNullable(item)) as JsonSchemaProperty[];
    }

    const transformed = { ...schema };

    // If this is an object schema with properties
    if (transformed.type === "object" && transformed.properties) {
      const required = new Set(transformed.required || []);
      
      // For each property that's not required, allow null values
      for (const [propName, propSchema] of Object.entries(transformed.properties)) {
        if (!required.has(propName) && typeof propSchema === "object" && !Array.isArray(propSchema)) {
          
          // If it has a simple type and isn't already allowing null
          if (propSchema.type && typeof propSchema.type === "string" && propSchema.type !== "null") {
            // Make it accept both the original type and null
            transformed.properties[propName] = {
              ...propSchema,
              anyOf: [
                { ...propSchema, type: propSchema.type },
                { type: "null" }
              ]
            };
            // Remove the type field as it's now in anyOf
            delete transformed.properties[propName].type;
          }
        }
        
        // Recursively transform nested schemas
        const nestedSchema = transformed.properties[propName];
        if (nestedSchema) {
          transformed.properties[propName] = this.makeOptionalFieldsNullable(
            nestedSchema
          ) as JsonSchemaProperty;
        }
      }
    }

    // Handle $ref - don't transform, let AJV resolve it
    if (transformed.$ref) {
      return transformed;
    }

    // Recursively handle nested schemas in allOf, anyOf, oneOf
    if (transformed.allOf) {
      transformed.allOf = transformed.allOf.map((s) =>
        this.makeOptionalFieldsNullable(s)
      ) as JsonSchemaProperty[];
    }
    if (transformed.anyOf) {
      transformed.anyOf = transformed.anyOf.map((s) =>
        this.makeOptionalFieldsNullable(s)
      ) as JsonSchemaProperty[];
    }
    if (transformed.oneOf) {
      transformed.oneOf = transformed.oneOf.map((s) =>
        this.makeOptionalFieldsNullable(s)
      ) as JsonSchemaProperty[];
    }

    return transformed;
  }

  private async loadSchemasFromContent(yamlContent: string): Promise<void> {
    if (!this.ajv) return;

    try {
      // Dynamically import yaml only when needed for tree-shaking
      const yaml = await import("yaml");
      const spec = yaml.parse(yamlContent) as {
        components?: {
          schemas?: Record<string, JsonSchemaProperty>;
        };
      };

      // Load the complete schema document first to enable reference resolution
      if (spec?.components?.schemas) {
        // Transform schemas to allow null for optional fields
        for (const [schemaName, schemaDefinition] of Object.entries(spec.components.schemas)) {
          const transformed = this.makeOptionalFieldsNullable(schemaDefinition);
          // Schemas in the components should always be objects, not arrays
          if (transformed) {
            if (Array.isArray(transformed)) {
              // Arrays shouldn't appear at the schema root level, but handle gracefully
              const firstItem = transformed[0];
              if (firstItem) {
                spec.components.schemas[schemaName] = firstItem;
              }
            } else {
              spec.components.schemas[schemaName] = transformed;
            }
          }
        }

        // Add the full schema document with an ID so references can be resolved
        this.ajv.addSchema(spec, "#");
        logger.debug(`Added full schema document with ID "#"`);

        // Then add individual schemas for direct validation with full reference paths
        for (const [schemaName, schemaDefinition] of Object.entries(spec.components.schemas)) {
          const fullSchemaPath = `#/components/schemas/${schemaName}`;
          this.ajv.addSchema(schemaDefinition as object, fullSchemaPath);
          logger.debug(`Added schema: "${fullSchemaPath}"`);
          this.schemaCount++;
        }

        // Debug: Show schema count
        logger.debug(`Instance ${this.instanceId} - Loaded ${this.schemaCount} schemas`);
      }

      logger.debug(`Loaded ${this.schemaCount} JSON schemas from embedded content`);
    } catch (error) {
      this.handleError(`Could not load schemas from embedded content:`, error);
    }
  }

  /**
   * Validate an array of items against a schema
   */
  async validateArraySchema<T>(data: unknown, itemSchemaName: string): Promise<T[]> {
    // If validation is disabled, just return data as-is
    if (!this.validation) {
      return data as T[];
    }

    // Wait for schema to be loaded
    await this.schemaReady;
    if (!Array.isArray(data)) {
      this.handleError(`Expected array but got ${typeof data}`);
      return data as T[];
    }

    // Validate each item in the array
    for (let i = 0; i < data.length; i++) {
      await this.validateSchema<T>(data[i], itemSchemaName);
    }

    return data as T[];
  }

  /**
   * Validate data against a schema and return typed result
   */
  async validateSchema<T>(data: unknown, schemaName: string): Promise<T> {
    // If validation is disabled, just return data as-is
    if (!this.validation) {
      return data as T;
    }

    // Wait for schema to be loaded
    await this.schemaReady;

    if (!this.ajv) {
      this.handleError(`Validation not available - ajv not initialized`);
      return data as T;
    }

    logger.debug(
      `🔍 Instance ${this.instanceId} - Attempting to validate against schema: "${schemaName}",`,
      { data }
    );

    try {
      // Check if schema exists
      const schema = this.ajv.getSchema(schemaName);
      if (!schema) {
        logger.warn(`Schema "${schemaName}" not found in AJV`);
        this.handleError(`Schema "${schemaName}" not found`);
        return data as T;
      }
      const isValid = this.ajv.validate(schemaName, data);
      if (!isValid) {
        const errorDetails = this.ajv.errorsText();
        logger.warn(`Validation errors: ${errorDetails}`);
        logger.debug(`Full validation errors:`, this.ajv.errors);
        this.handleError(
          `Schema validation failed for ${schemaName}: ${errorDetails}`,
          new Error(`Schema validation failed for ${schemaName}: ${errorDetails}`)
        );
      } else {
        logger.debug(`Validation successful for "${schemaName}"`);
      }
    } catch (error) {
      this.handleError(`Validation error for ${schemaName}: ${error}`);
    }

    return data as T;
  }
}
