/**
 * Wire → branded constructors: `disclosedContractFromWire` and
 * `createContractId`. These cross the boundary where a disclosure / contract id
 * arrives as a plain string (relayed through a backend API or a scan node) and
 * a typed ledger API needs the brand. The unchecked cast is meant to live in
 * these functions, once — these tests pin their validation + shape.
 */
import {
  createContractId,
  disclosedContractFromWire,
  type WireDisclosedContract,
} from "./types";

const wire: WireDisclosedContract = {
  contractId: "00abc123",
  createdEventBlob: "ZXZlbnQtYmxvYg==",
  templateId: "abcd1234:C7Lock:LockRequest",
  synchronizerId: "sync::1220beef",
};

describe("disclosedContractFromWire", () => {
  it("maps the four wire fields onto a DisclosedContract", () => {
    const dc = disclosedContractFromWire(wire);
    expect(dc).toEqual({
      contractId: "00abc123",
      createdEventBlob: "ZXZlbnQtYmxvYg==",
      templateId: "abcd1234:C7Lock:LockRequest",
      synchronizerId: "sync::1220beef",
    });
  });

  it("preserves a colon-bearing template id verbatim (not a bare package id)", () => {
    const dc = disclosedContractFromWire(wire);
    // The brand is compile-time only; at runtime the string is unchanged.
    expect(dc.templateId).toBe("abcd1234:C7Lock:LockRequest");
  });

  it("throws when createdEventBlob is empty", () => {
    expect(() =>
      disclosedContractFromWire({ ...wire, createdEventBlob: "" }),
    ).toThrow(/createdEventBlob is empty/);
  });

  it("throws when synchronizerId is empty", () => {
    expect(() =>
      disclosedContractFromWire({ ...wire, synchronizerId: "" }),
    ).toThrow(/synchronizerId is empty/);
  });
});

describe("createContractId", () => {
  it("brands a valid LedgerString-formatted contract id (returns it unchanged at runtime)", () => {
    const cid = createContractId("00deadbeef");
    expect(cid as unknown as string).toBe("00deadbeef");
  });

  it("accepts the punctuation contract ids use (#:-_/)", () => {
    expect(() => createContractId("00a:b#c-d_e/f")).not.toThrow();
  });

  it("throws on characters outside the LedgerString format", () => {
    expect(() => createContractId("not valid!")).toThrow(/Invalid ContractId/);
  });

  it("throws on an empty string", () => {
    expect(() => createContractId("")).toThrow(/Invalid ContractId/);
  });
});
