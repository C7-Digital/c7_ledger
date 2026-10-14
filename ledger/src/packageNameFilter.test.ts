/**
 * `toPackageNameId` rewrites a package-id template/interface id to its
 * package-name form for Ledger API filters. Canton 3.5+ rejects a filter id
 * that carries an explicit package id ("expected a package name"), so a
 * subscription filtered by the codegen's package-id ids matches nothing. These
 * pin the rewrite and its fail-open fallbacks.
 */
import { toPackageNameId } from "./ledger";
import type { IdentifierString } from "./valueTypes";
import type { VersionedRegistry, VersionedLookupResult } from "./types";

const PKG_ID = "d9795c95:TermsOfService:TermsOfService" as IdentifierString;
const NAME_ID = "#example-model:TermsOfService:TermsOfService";

// A registry that resolves the one package-id above to a result carrying the
// package name, and anything else to undefined — matching the codegen's
// versionedRegistry shape. The `template` payload is irrelevant to the rewrite,
// so it is stubbed through `unknown`.
const registry: VersionedRegistry = (id: string) =>
  id === PKG_ID || id === NAME_ID
    ? ({
        type: "template",
        template: {},
        version: "0.1.1",
        packageName: "example-model",
      } as unknown as VersionedLookupResult)
    : undefined;

describe("toPackageNameId", () => {
  it("rewrites a package-id id to its #<package-name> form", () => {
    expect(toPackageNameId(PKG_ID, registry)).toBe(NAME_ID);
  });

  it("leaves an already-name-form id unchanged", () => {
    expect(toPackageNameId(NAME_ID as IdentifierString, registry)).toBe(NAME_ID);
  });

  it("returns the id unchanged when no registry is supplied", () => {
    expect(toPackageNameId(PKG_ID)).toBe(PKG_ID);
  });

  it("returns the id unchanged when the registry does not know it (fail open)", () => {
    const unknown = "beefcafe:Other:Other" as IdentifierString;
    expect(toPackageNameId(unknown, registry)).toBe(unknown);
  });

  it("returns the id unchanged when the registry result carries no packageName", () => {
    const noName: VersionedRegistry = () =>
      ({ type: "template", template: {}, version: "0.1.1" } as unknown as VersionedLookupResult);
    expect(toPackageNameId(PKG_ID, noName)).toBe(PKG_ID);
  });
});
