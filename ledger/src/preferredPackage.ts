// The preferred package of one package name, as a sum type.
//
// `POST /v2/interactive-submission/preferred-packages` answers "which package
// of this name do these parties use?". The participant rejects the request
// when there is no such package, with one of two Canton codes:
//
//   - `NO_PREFERRED_PACKAGES_FOUND`: no vetted package of the name satisfies
//     the requirement on the connected synchronizers.
//   - `PACKAGE_NAMES_NOT_FOUND`: the participant does not know the name.
//
// For a caller, both rejects mean the same thing: the parties cannot use a
// package of that name. So {@link isNoPreferredPackage} reads both as "none",
// and {@link PreferredPackage} makes "none" a case of the answer, not an error.
// Each other reject stays an error.

import { cantonErrorOf } from "./cantonError";
import type { PackageReference } from "./types";

/** The Canton codes that mean "the parties cannot use a package of this name". */
const NO_PREFERRED_PACKAGE_CODES: ReadonlySet<string> = new Set([
  "NO_PREFERRED_PACKAGES_FOUND",
  "PACKAGE_NAMES_NOT_FOUND",
]);

/** The preferred package of one package name for a set of parties. */
export type PreferredPackage =
  | { kind: "vetted"; reference: PackageReference }
  | { kind: "none" };

/**
 * Whether a thrown value is the reject that means "the parties cannot use a
 * package of this name". Reads the Canton payload structurally (see
 * {@link cantonErrorOf}), so it also reads a payload that a wallet-gateway
 * decoder gives.
 */
export function isNoPreferredPackage(e: unknown): boolean {
  const code = cantonErrorOf(e)?.code;
  return code !== undefined && NO_PREFERRED_PACKAGE_CODES.has(code);
}

/**
 * The reference for `packageName` in a preferred-packages answer. The
 * participant gives one reference for each requested name, in no specified
 * order, so this finds it by name.
 *
 * @throws {Error} when the answer has no reference for `packageName`.
 */
export function preferredReferenceOf(
  packageReferences: readonly PackageReference[],
  packageName: string,
): PackageReference {
  const reference = packageReferences.find((r) => r.packageName === packageName);
  if (reference === undefined) {
    throw new Error(`preferred-packages returned no reference for ${packageName}`);
  }
  return reference;
}
