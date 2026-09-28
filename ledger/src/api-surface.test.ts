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
import { createPartyIdString } from "./valueTypes";

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
    "createEventsFromWire",
    "exerciseCmd",
    "setLogger",
    "toDisclosedContract",
    "disclosedContractFromWire",
    "createContractId",
    // Canton error vocabulary — accessors over the JsCantonError payload that
    // both the direct JSON-API path and a wallet-gateway decoder produce.
    "categoryOf",
    "isRetryable",
    "resourcesOf",
    "cantonErrorOf",
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
    "isValidIdentifierString",
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
    "createIdentifierString",
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
      /^import \{ LedgerString, PartyIdString, UserIdString, NameString, PackageIdString, IdentifierString \} from "\.\.\/valueTypes\.js"/
    );
  });

  it("async-api.ts starts with branded type imports", () => {
    expect(asyncApiContent).toMatch(
      /^import \{ LedgerString, PartyIdString, UserIdString, NameString, PackageIdString, IdentifierString \} from "\.\.\/valueTypes\.js"/
    );
  });

  it.each([
    ["contractId: LedgerString", /contractId\??:\s*LedgerString/],
    ["templateId: IdentifierString", /templateId\??:\s*IdentifierString/],
    ["userId: UserIdString", /userId\??:\s*UserIdString/],
    ["choice: NameString", /choice\??:\s*NameString/],
    ["partyIdHint: PartyIdString", /partyIdHint\??:\s*PartyIdString/],
  ])("api.ts uses branded type for %s", (_label, pattern) => {
    expect(apiContent).toMatch(pattern);
  });

  it.each([
    ["contractId: LedgerString", /contractId\??:\s*LedgerString/],
    ["templateId: IdentifierString", /templateId\??:\s*IdentifierString/],
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
    "exerciseResult",
    "submit",
    "submitWithDisclosures",
    "streamQuery",
    "streamQueryInterface",
    "streamHistoryUpdates",
    "probeOffset",
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

describe("allocateParty request shape", () => {
  it("targets the default identity provider via empty id, not the literal 'default'", async () => {
    const ledger = new Ledger({ token: TEST_TOKEN, httpBaseUrl: "http://localhost:7575" });
    let captured: any;
    // Spy on the underlying HTTP client so we assert the request body without a
    // live ledger. Canton's default IDP id is "" — sending "default" fails with
    // INVALID_ARGUMENT ("identity_provider_id Id(default) has not been found").
    (ledger as any).client.allocateParty = async (req: any) => {
      captured = req;
      return { partyDetails: { party: "alice::1220abcd", isLocal: true } };
    };

    await ledger.allocateParty({ partyIdHint: createPartyIdString("alice") });

    expect(captured.identityProviderId).toBe("");
    expect(captured.identityProviderId).not.toBe("default");
  });
});

describe("createUser request shape", () => {
  it("sets user.identityProviderId to '' (required by the JSON Ledger API)", async () => {
    const ledger = new Ledger({ token: TEST_TOKEN, httpBaseUrl: "http://localhost:7575" });
    let captured: any;
    // The JSON Ledger API rejects createUser without `user.identityProviderId`
    // (HTTP 400 "Missing required field at 'identityProviderId'"); "" selects the
    // default identity provider.
    (ledger as any).client.createUser = async (req: any) => {
      captured = req;
      return { user: req.user };
    };

    await ledger.createUser("bdd-user", ["alice::1220abcd"] as any);

    expect(captured.user.identityProviderId).toBe("");
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

// ─── exerciseResult ────────────────────────────────────────────────────
//
// `exerciseResult` is the only public method whose behaviour depends on
// the LEDGER_EFFECTS transaction shape — the response carries an
// `ExercisedEvent` whose `exerciseResult` field is the JSON-encoded
// Daml return value. The tests stub `client.submitAndWaitForTransaction`
// (same pattern as `allocateParty` / `createUser` shape tests above) to
// verify three contract points:
//
//   1. The request opts into TRANSACTION_SHAPE_LEDGER_EFFECTS — without
//      it the server would default to ACS_DELTA and the response would
//      carry no ExercisedEvent at all.
//   2. The matching ExercisedEvent's `exerciseResult` is decoded via
//      the choice's `resultDecoder` and returned.
//   3. The two error paths throw a clear, debuggable message rather
//      than returning `undefined` or the raw wire JSON.
//
// All three use a hand-rolled minimal Choice stub — the same trick
// `events.test.ts` uses for Template stubs. The library's
// `Ledger.exerciseResult` only reads `template().templateId`,
// `choiceName`, `argumentEncode`, and `resultDecoder` off it, so we
// don't need a real codegen-emitted Choice.

interface Quote {
  amount: number;
}

function fakeQuoteChoice(opts?: {
  templateId?: string;
  choiceName?: string;
}): any {
  return {
    template: () => ({
      templateId: opts?.templateId ?? "#c7lock-model:C7Lock:Loan",
    }),
    choiceName: opts?.choiceName ?? "QuoteNextPayment",
    argumentEncode: (_: unknown) => ({}),
    resultDecoder: {
      runWithException: (raw: unknown) => raw as Quote,
    },
  };
}

const FAKE_CID = "00abcd1234567890" as any;

describe("exerciseResult", () => {
  it("requests LEDGER_EFFECTS and returns the decoded result on the happy path", async () => {
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://localhost:7575",
    });
    const choice = fakeQuoteChoice();
    let captured: any;
    (ledger as any).client.submitAndWaitForTransaction = async (req: any) => {
      captured = req;
      return {
        transaction: {
          events: [
            {
              ExercisedEvent: {
                choice: choice.choiceName,
                contractId: FAKE_CID,
                exerciseResult: { amount: 42 },
              },
            },
          ],
        },
      };
    };

    const result = await ledger.exerciseResult<object, {}, Quote>(
      choice,
      FAKE_CID,
      {},
      [createPartyIdString("alice")]
    );

    expect(result).toEqual({ amount: 42 });
    expect(captured.transactionFormat.transactionShape).toBe(
      "TRANSACTION_SHAPE_LEDGER_EFFECTS"
    );
    // The eventFormat MUST carry a wildcard entry for the active party so
    // the LEDGER_EFFECTS server includes our root exercise event — a
    // missing or wrong-party filter would drop the only event we care about.
    expect(
      captured.transactionFormat.eventFormat.filtersByParty
    ).toHaveProperty("alice");
  });

  it("throws when no ExercisedEvent matches the (choice, contractId) pair", async () => {
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://localhost:7575",
    });
    const choice = fakeQuoteChoice();
    (ledger as any).client.submitAndWaitForTransaction = async () => ({
      transaction: {
        events: [
          // Wrong choice name + wrong contract id — covers both "no
          // exercise event at all" and "exercise event but for a
          // different choice".
          {
            ExercisedEvent: {
              choice: "SomeOtherChoice",
              contractId: "some-other-cid",
              exerciseResult: { amount: 99 },
            },
          },
        ],
      },
    });

    await expect(
      ledger.exerciseResult<object, {}, Quote>(choice, FAKE_CID, {}, [
        createPartyIdString("alice"),
      ])
    ).rejects.toThrow(/no matching ExercisedEvent/i);
  });

  it("throws when the matching ExercisedEvent has no exerciseResult", async () => {
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://localhost:7575",
    });
    const choice = fakeQuoteChoice();
    (ledger as any).client.submitAndWaitForTransaction = async () => ({
      transaction: {
        events: [
          {
            ExercisedEvent: {
              choice: choice.choiceName,
              contractId: FAKE_CID,
              // exerciseResult intentionally omitted — simulates a
              // server that returned LEDGER_EFFECTS but stripped the
              // result field (would be a bug, but the library should
              // surface it loudly, not return `undefined`).
            },
          },
        ],
      },
    });

    await expect(
      ledger.exerciseResult<object, {}, Quote>(choice, FAKE_CID, {}, [
        createPartyIdString("alice"),
      ])
    ).rejects.toThrow(/no exerciseResult/i);
  });
});
