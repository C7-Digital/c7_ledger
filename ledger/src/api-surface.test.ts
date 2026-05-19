/**
 * API Surface Tests
 *
 * These tests verify the public API contract of the ledger package.
 * They are designed to catch breaking changes during SDK version upgrades
 * by asserting exports, method signatures, generated type shapes, and branded types.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as LedgerPackage from "./index";
import type { components } from "./generated/api";
import type { channels } from "./generated/async-api";
import { Ledger } from "./ledger";
import { TypedHttpClient } from "./client";
import { WebSocketClient } from "./websocket";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Valid JWT token for testing with sub field
// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"test-user","iat":1516239022}
const TEST_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("Public API surface", () => {
  // Classes
  it.each([
    "Ledger",
    "TypedHttpClient",
    "WebSocketClient",
    "ConsoleLogger",
    "NoOpLogger",
  ])("exports class %s", (name) => {
    expect(typeof (LedgerPackage as any)[name]).toBe("function");
  });

  // Functions
  it.each([
    "createCmd",
    "createAndExerciseCmd",
    "exerciseCmd",
    "setLogger",
  ])("exports function %s", (name) => {
    expect(typeof (LedgerPackage as any)[name]).toBe("function");
  });

  // Objects
  it.each([
    "logger",
    "ValueStringValidators",
    "ValueStringCreators",
  ])("exports object %s", (name) => {
    expect(typeof (LedgerPackage as any)[name]).toBe("object");
  });

  // Constants
  it("exports SDK_VERSION as a string", () => {
    expect(typeof LedgerPackage.SDK_VERSION).toBe("string");
  });

  // Validator functions
  it.each([
    "isValidNameString",
    "isValidPackageIdString",
    "isValidPartyIdString",
    "isValidLedgerString",
    "isValidUserIdString",
  ])("exports validator function %s", (name) => {
    expect(typeof (LedgerPackage as any)[name]).toBe("function");
  });

  // Creator functions
  it.each([
    "createNameString",
    "createPackageIdString",
    "createPartyIdString",
    "createLedgerString",
    "createUserIdString",
  ])("exports creator function %s", (name) => {
    expect(typeof (LedgerPackage as any)[name]).toBe("function");
  });
});

describe("Generated type structure", () => {
  // These tests use compile-time type assertions. If a schema property is
  // removed or renamed, the TypeScript compiler (via ts-jest) will fail here.

  it("CreatedEvent has expected properties", () => {
    type CreatedEvent = components["schemas"]["CreatedEvent"];
    const keys: (keyof CreatedEvent)[] = [
      "offset",
      "nodeId",
      "contractId",
      "templateId",
    ];
    // Compile-time check passes if the above compiles; runtime sanity:
    expect(keys).toEqual(["offset", "nodeId", "contractId", "templateId"]);
  });

  it("ArchivedEvent has expected properties", () => {
    type ArchivedEvent = components["schemas"]["ArchivedEvent"];
    const keys: (keyof ArchivedEvent)[] = [
      "offset",
      "nodeId",
      "contractId",
      "templateId",
    ];
    expect(keys).toEqual(["offset", "nodeId", "contractId", "templateId"]);
  });
});

describe("Branded type verification", () => {
  const apiFilePath = path.resolve(__dirname, "generated/api.ts");
  const asyncApiFilePath = path.resolve(__dirname, "generated/async-api.ts");

  let apiContent: string;
  let asyncApiContent: string;

  beforeAll(() => {
    apiContent = fs.readFileSync(apiFilePath, "utf-8");
    asyncApiContent = fs.readFileSync(asyncApiFilePath, "utf-8");
  });

  it("api.ts starts with branded type imports", () => {
    expect(apiContent).toMatch(
      /^import \{ LedgerString, PartyIdString, UserIdString, NameString, PackageIdString \} from "\.\.\/valueTypes\.js"/
    );
  });

  it("async-api.ts starts with branded type imports", () => {
    expect(asyncApiContent).toMatch(
      /^import \{ LedgerString, PartyIdString, UserIdString, NameString, PackageIdString \} from "\.\.\/valueTypes\.js"/
    );
  });

  it.each([
    ["contractId: LedgerString", /contractId\??:\s*LedgerString/],
    ["templateId: PackageIdString", /templateId\??:\s*PackageIdString/],
    ["userId: UserIdString", /userId\??:\s*UserIdString/],
    ["choice: NameString", /choice\??:\s*NameString/],
    ["partyIdHint: PartyIdString", /partyIdHint\??:\s*PartyIdString/],
  ])("api.ts uses branded type for %s", (_label, pattern) => {
    expect(apiContent).toMatch(pattern);
  });

  it.each([
    ["contractId: LedgerString", /contractId\??:\s*LedgerString/],
    ["templateId: PackageIdString", /templateId\??:\s*PackageIdString/],
    ["userId: UserIdString", /userId\??:\s*UserIdString/],
    ["choice: NameString", /choice\??:\s*NameString/],
  ])("async-api.ts uses branded type for %s", (_label, pattern) => {
    expect(asyncApiContent).toMatch(pattern);
  });
});

describe("Ledger method contract", () => {
  const ledger = new Ledger({
    token: TEST_TOKEN,
    httpBaseUrl: "http://localhost:7575",
  });

  it.each([
    "getTokenUserId",
    "getTokenUserInfo",
    "getTokenActAsParties",
    "query",
    "queryInterface",
    "create",
    "exercise",
    "submit",
    "submitWithDisclosures",
    "streamQuery",
    "streamQueryInterface",
    "createMultiStream",
    "createMultiInterfaceStream",
    "getUserInfo",
    "getParties",
    "allocateParty",
  ])("Ledger.prototype has method %s", (method) => {
    expect(typeof (ledger as any)[method]).toBe("function");
  });

  it.each([
    "submitAndWait",
    "submitAndWaitForTransaction",
    "getParties",
    "getUserInfo",
    "getUserRights",
    "queryActiveContracts",
    "allocateParty",
    "getLedgerEnd",
  ])("TypedHttpClient.prototype has method %s", (method) => {
    expect(typeof TypedHttpClient.prototype[method as keyof TypedHttpClient]).toBe("function");
  });

  it.each([
    "getToken",
    "setToken",
    "streamCompletions",
    "streamActiveContracts",
    "streamUpdates",
  ])("WebSocketClient.prototype has method %s", (method) => {
    expect(typeof WebSocketClient.prototype[method as keyof WebSocketClient]).toBe("function");
  });
});

describe("SDK version", () => {
  it("SDK_VERSION equals 3.5.1-snapshot.20260423.18760.0", () => {
    expect(LedgerPackage.SDK_VERSION).toBe("3.5.1-snapshot.20260423.18760.0");
  });

  it("SDK_VERSION matches semver-or-snapshot pattern", () => {
    expect(LedgerPackage.SDK_VERSION).toMatch(
      /^\d+\.\d+\.\d+(-snapshot\.\d{8}\.\d+\.\d+)?$/
    );
  });
});
