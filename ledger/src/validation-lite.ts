/**
 * Lite runtime validation utilities - validation is disabled in lite builds
 *
 * This module provides stub implementations that pass data through without validation.
 * Use the full @c7-digital/ledger package if you need runtime schema validation.
 */
import { logger } from "./logger";

export type ValidationMode = "throwOnError" | "logErrors";

export class SchemaValidator {
  private instanceId: string;
  private schemaReady: Promise<void>;

  constructor(schemaType: "openapi" | "asyncapi" = "openapi", validation?: ValidationMode) {
    this.instanceId = Math.random().toString(36).substring(2, 8);

    if (validation) {
      logger.warn(
        `SchemaValidator instance ${this.instanceId}: Validation requested but using lite build. ` +
          `Install the full @c7-digital/ledger package for runtime validation support.`
      );
    }

    this.schemaReady = Promise.resolve();
  }

  /**
   * Validate an array of items against a schema (lite: pass-through)
   */
  async validateArraySchema<T>(data: unknown, _itemSchemaName: string): Promise<T[]> {
    await this.schemaReady;
    return data as T[];
  }

  /**
   * Validate data against a schema and return typed result (lite: pass-through)
   */
  async validateSchema<T>(data: unknown, _schemaName: string): Promise<T> {
    await this.schemaReady;
    return data as T;
  }
}
