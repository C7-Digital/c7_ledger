#!/usr/bin/env node
// Script to automatically brand OpenAPI generated types with value.proto constraints
// Ideally the spec would provide this, but this is sufficient for now.

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";

interface ValueProtoPattern {
  // The JSDoc comment pattern to match
  commentPattern: string;
  // The target type to replace with (for string fields)
  targetType: string;
}

// Patterns to find fields with value.proto references based on JSDoc comments
// Each entry automatically handles both string and string[] cases
const VALUE_PROTO_PATTERNS: ValueProtoPattern[] = [
  // LedgerString patterns
  {
    commentPattern: "Must be a valid LedgerString",
    targetType: "LedgerString",
  },

  // PartyIdString patterns
  {
    commentPattern: "Must be a valid PartyIdString",
    targetType: "PartyIdString",
  },

  // UserIdString patterns
  {
    commentPattern: "Must be a valid UserIdString",
    targetType: "UserIdString",
  },

  // NameString patterns
  {
    commentPattern: "Must be a valid NameString",
    targetType: "NameString",
  },

  // PackageIdString patterns
  {
    commentPattern: "Must be a valid PackageIdString",
    targetType: "PackageIdString",
  },
  // A field "in package-id reference format" is a full template/interface
  // identifier ("<package>:<module>:<entity>"), NOT a bare package id — so it
  // gets the IdentifierString brand, whose validator accepts the colon form.
  {
    commentPattern: "The identifier uses the package-id reference format",
    targetType: "IdentifierString",
  },
];

function brandApiTypes(inputPath: string, outputPath: string, label: string): number {
  console.log(`🔄 Branding ${label} types with value.proto constraints...`);
  const content = readFileSync(inputPath, "utf-8");
  let brandedContent = content;

  // Add imports at the top if not already present
  if (!content.includes('from "../valueTypes.js"')) {
    const importStatement = `import { LedgerString, PartyIdString, UserIdString, NameString, PackageIdString, IdentifierString } from "../valueTypes.js";\n\n`;
    brandedContent = importStatement + brandedContent;
  }

  let replacementCount = 0;

  // Track usage of each comment pattern
  const patternUsage = new Map<string, { count: number; examples: string[] }>();

  // This regex captures JSDoc comments followed by field declarations
  // We're looking for: /** JSDoc comment */ fieldName?: fieldType;
  // 
  // Regex breakdown:
  // /\/\*\*                           - Match opening /** (literal forward slash, asterisk, asterisk)
  // ([^*]|[\r\n]|(\*+([^*/]|[\r\n])))* - Match JSDoc content (non-greedy):
  //   [^*]                            - Any character except asterisk
  //   |[\r\n]                         - OR newline characters (carriage return or line feed)
  //   |(\*+([^*/]|[\r\n]))            - OR one or more asterisks followed by non-closing chars
  // \*+\/                             - Match closing */ (one or more asterisks + forward slash)
  // \s*                               - Match optional whitespace after JSDoc
  // (\w+)                             - Capture group 4: field name (word characters)
  // (\?)?                             - Capture group 5: optional question mark for optional fields
  // \s*:\s*                           - Match colon with optional whitespace around it
  // ([^;,\}\n]+)                      - Capture group 6: field type (everything except semicolon, comma, closing brace, newline)
  //
  // The regex handles multi-line JSDoc with @description tags and indented fields within object types
  const fieldRegex =
    /\/\*\*([^*]|[\r\n]|(\*+([^*/]|[\r\n])))*\*+\/\s*(\w+)(\?)?\s*:\s*([^;,\}\n]+)/g;

  // Use a more compatible approach for regex matching
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(content)) !== null) {
    matches.push(match);
  }


  // Process each match
  for (const match of matches) {
    if (match.length < 6) continue;

    const fullMatch = match[0];
    const jsDocComment = match[0].substring(3, match[0].indexOf("*/")); // Extract JSDoc content
    const fieldName = match[4]; // Field name
    const isOptional = match[5] === "?"; // Optional marker
    const fieldType = match[6]; // Field type (could be anything)


    // Skip if we don't have the necessary data
    if (!fullMatch || !fieldName || !fieldType) continue;

    // Check if this is a string-related type that we care about
    const trimmedFieldType = fieldType.trim();
    if (trimmedFieldType === "string" || trimmedFieldType === "string[]") {
      // Check if the JSDoc comment matches any of our patterns
      for (const { commentPattern, targetType } of VALUE_PROTO_PATTERNS) {
        // Check if JSDoc contains the pattern
        if (jsDocComment.includes(commentPattern)) {
          // Extra validation: ensure this is actually a value.proto constraint comment
          if (
            commentPattern.includes("Must be a valid") ||
            commentPattern.includes("package-id reference format")
          ) {
            // Determine the correct target type based on whether it's an array
            const finalTargetType =
              trimmedFieldType === "string[]" ? `${targetType}[]` : targetType;

            // Create the branded declaration
            const brandedDeclaration = fullMatch.replace(trimmedFieldType, finalTargetType);

            // Replace in the content
            brandedContent = brandedContent.replace(fullMatch, brandedDeclaration);
            replacementCount++;

            // Track pattern usage
            const fieldExample = `${fieldName}${isOptional ? "?" : ""}: ${trimmedFieldType} → ${finalTargetType}`;
            if (!patternUsage.has(commentPattern)) {
              patternUsage.set(commentPattern, { count: 0, examples: [] });
            }
            const usage = patternUsage.get(commentPattern)!;
            usage.count++;
            if (usage.examples.length < 3) {
              // Keep up to 3 examples per pattern
              usage.examples.push(fieldExample);
            }

            // Log the branding with field name
            const optionalMarker = isOptional ? "?" : "";
            console.log(
              `✅ Branded ${fieldName}${optionalMarker}: ${trimmedFieldType} → ${finalTargetType}`
            );
            // console.log(`JSDoc: ${jsDocComment}`);
            // console.log(`Pattern: ${commentPattern}`);
            // console.log(`---------------------------------`);
            break; // Stop checking patterns once we've found a match
          }
        }
      }
    }
  }

  // Write branded content directly to the output file
  console.log(`📝 Writing branded types to ${outputPath}...`);
  writeFileSync(outputPath, brandedContent);

  console.log(`🎉 Branded ${replacementCount} field declarations with value.proto constraints`);

  // Report pattern usage summary
  if (patternUsage.size > 0) {
    console.log(`\n📊 Pattern Usage Summary:`);
    console.log(`════════════════════════════════════════`);

    // Sort patterns by usage count (descending)
    const sortedPatterns = Array.from(patternUsage.entries()).sort(
      ([, a], [, b]) => b.count - a.count
    );

    for (const [pattern, { count, examples }] of sortedPatterns) {
      console.log(`\n🔖 "${pattern}"`);
      console.log(`   Used ${count} time${count === 1 ? "" : "s"}`);
      console.log(`   Examples:`);
      for (const example of examples) {
        console.log(`     • ${example}`);
      }
      if (count > examples.length) {
        console.log(`     ... and ${count - examples.length} more`);
      }
    }
    console.log(`\n════════════════════════════════════════`);
  }

  return replacementCount;
}

function brandTypes(inputPath: string, outputPath: string, label: string = "API"): void {
  brandApiTypes(inputPath, outputPath, label);
}

// Export the function for use in other scripts
export { brandTypes };

// Check if this script is being run directly
// For ES modules, we check if the import.meta.url matches the process.argv[1]
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("brand-types.ts") || process.argv[1].endsWith("enhance-types.ts"));
if (isMainModule) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: brand-types.ts <input-file> <output-file> [label]");
    process.exit(1);
  }

  if (!args[0] || !args[1]) {
    console.error("Input and output files must be specified.");
    process.exit(1);
  }
  const inputPath = args[0];
  const outputPath = args[1];
  const label = args[2] || "API";

  brandTypes(inputPath, outputPath, label);
}
