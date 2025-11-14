import { PackageIdString } from "./valueTypes";

export function partiallyQualified(templateId: PackageIdString): string {
  return templateId.split(":").slice(1).join(":");
}

//
export function matchesPartiallyQualified(templateId: PackageIdString, other: string): boolean {
  return partiallyQualified(templateId) === other.split(":").slice(1).join(":");
}
