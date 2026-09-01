import { parseMissingPackageNames, filterMatchesPackageName } from "./ledger";
import { createIdentifierString } from "./valueTypes";

const id = createIdentifierString;

describe("parseMissingPackageNames", () => {
  it("extracts a single package name from the participant's cause", () => {
    const cause =
      "The following package names do not match upgradable packages uploaded on this participant: [c7-lei].";
    expect(parseMissingPackageNames(cause)).toEqual(["c7-lei"]);
  });

  it("extracts several comma-separated names and trims them", () => {
    const cause = "...uploaded on this participant: [c7-lei, other-pkg , third].";
    expect(parseMissingPackageNames(cause)).toEqual(["c7-lei", "other-pkg", "third"]);
  });

  it("returns [] when there is no bracketed list", () => {
    expect(parseMissingPackageNames("some unrelated error")).toEqual([]);
  });

  it("returns [] for an empty bracket, undefined, or empty cause", () => {
    expect(parseMissingPackageNames("prefix: [] suffix")).toEqual([]);
    expect(parseMissingPackageNames(undefined)).toEqual([]);
    expect(parseMissingPackageNames("")).toEqual([]);
  });
});

describe("filterMatchesPackageName", () => {
  it("matches a template filter in package-name form", () => {
    const filter = { type: "template", templateId: id("#c7-lei:C7.LEI:LEI") } as const;
    expect(filterMatchesPackageName(filter, ["c7-lei"])).toBe(true);
  });

  it("matches an interface filter in package-name form", () => {
    const filter = { type: "interface", interfaceId: id("#c7-lei:C7.LEI:HasLei") } as const;
    expect(filterMatchesPackageName(filter, ["c7-lei"])).toBe(true);
  });

  it("does not match a different package name", () => {
    const filter = { type: "template", templateId: id("#domain-verification-model:X:Y") } as const;
    expect(filterMatchesPackageName(filter, ["c7-lei"])).toBe(false);
  });

  it("never matches an id-form filter (a hash cannot be matched to a reported name)", () => {
    const filter = {
      type: "template",
      templateId: id("de60cd7fb0d4fe26b54431fc8233a12c21bc2541c402bbdebb99e12602fb851a:C7.LEI:LEI"),
    } as const;
    // Even if the hash's package happens to be c7-lei, the participant reports a
    // NAME, so an id-form filter is left in place and the error surfaces instead.
    expect(filterMatchesPackageName(filter, ["c7-lei"])).toBe(false);
  });
});
