import { IdentifierString } from "./valueTypes";

export function partiallyQualified(templateId: IdentifierString): string {
  return templateId.split(":").slice(1).join(":");
}

//
export function matchesPartiallyQualified(templateId: IdentifierString, other: string): boolean {
  return partiallyQualified(templateId) === other.split(":").slice(1).join(":");
}
