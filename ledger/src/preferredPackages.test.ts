/**
 * `getPreferredPackages` against the answers that a participant can give.
 * `Ledger.getPreferredPackages` gives the same answers as `TypedHttpClient`.
 *
 * The client does not interpret the answer: it sends the request body as it is
 * and returns the response as it is. A reject arrives as a LedgerApiError that
 * carries the Canton code, so a caller can tell "no package" from a failure.
 * `isNoPreferredPackage` reads that code, and `Ledger.getPreferredPackage`
 * gives "no package" as a case of its answer.
 */
import { TypedHttpClient } from "./client";
import { LedgerApiError } from "./error";
import { Ledger } from "./ledger";
import { isNoPreferredPackage, preferredReferenceOf } from "./preferredPackage";
import type {
  GetPreferredPackagesRequest,
  GetPreferredPackagesResponse,
  JsCantonError,
  PackageReference,
} from "./types";

const TEST_TOKEN = "test-token";
const BASE_URL = "http://localhost:7575";

interface Captured {
  url: string;
  init: RequestInit;
}

function respond(status: number, body: string): { client: TypedHttpClient; calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, statusText: status === 200 ? "OK" : "Error" });
  }) as unknown as typeof fetch;
  return { client: new TypedHttpClient({ token: TEST_TOKEN, baseUrl: BASE_URL }), calls };
}

/** The one request that the client sent. */
function onlyCall(calls: Captured[]): Captured {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (!call) throw new Error("expected one request");
  return call;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const request: GetPreferredPackagesRequest = {
  packageVettingRequirements: [
    { parties: ["alice::1220aa"], packageName: "model" },
    { parties: ["alice::1220aa", "bob::1220bb"], packageName: "lib" },
  ],
};

const reference = (packageName: string, packageVersion: string) => ({
  packageId: `${packageName}-${packageVersion}-id`,
  packageName,
  packageVersion,
});

const cantonError = (code: string, errorCategory: number): JsCantonError => ({
  code,
  cause: `${code} cause`,
  context: {},
  errorCategory,
  grpcCodeValue: 9,
});

describe("getPreferredPackages request", () => {
  it("POSTs the request body unchanged to the preferred-packages path", async () => {
    const response: GetPreferredPackagesResponse = {
      packageReferences: [reference("model", "1.0.0"), reference("lib", "2.0.0")],
      synchronizerId: "global-domain::1220cc",
    };
    const { client, calls } = respond(200, JSON.stringify(response));
    await client.getPreferredPackages(request);

    const call = onlyCall(calls);
    expect(call.url).toBe(`${BASE_URL}/v2/interactive-submission/preferred-packages`);
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual(request);
    expect((call.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TEST_TOKEN}`,
    );
  });

  it("sends the optional synchronizer and vetting time when given", async () => {
    const pinned: GetPreferredPackagesRequest = {
      ...request,
      synchronizerId: "global-domain::1220cc",
      vettingValidAt: "2026-11-03T00:00:00Z",
    };
    const { client, calls } = respond(
      200,
      JSON.stringify({ packageReferences: [], synchronizerId: "global-domain::1220cc" }),
    );
    await client.getPreferredPackages(pinned);
    expect(JSON.parse(String(onlyCall(calls).init.body))).toEqual(pinned);
  });
});

describe("getPreferredPackages answers", () => {
  it.each<[string, GetPreferredPackagesResponse]>([
    [
      "one reference for one requested name",
      { packageReferences: [reference("model", "1.0.0")], synchronizerId: "sync::1" },
    ],
    [
      "references in an order other than the request",
      {
        packageReferences: [reference("lib", "2.0.0"), reference("model", "1.0.0")],
        synchronizerId: "sync::1",
      },
    ],
  ])("returns %s unchanged", async (_, response) => {
    const { client } = respond(200, JSON.stringify(response));
    expect(await client.getPreferredPackages(request)).toEqual(response);
  });

  it.each<[string, number, JsCantonError]>([
    // No package satisfies the vetting requirements on the connected synchronizers.
    ["no vetted package", 400, cantonError("NO_PREFERRED_PACKAGES_FOUND", 9)],
    // The participant does not know a requested package name.
    ["an unknown package name", 404, cantonError("PACKAGE_NAMES_NOT_FOUND", 11)],
  ])("rejects %s with the Canton code", async (_, status, error) => {
    const { client } = respond(status, JSON.stringify(error));
    const err = await client.getPreferredPackages(request).then(
      () => {
        throw new Error("expected the request to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LedgerApiError);
    expect((err as LedgerApiError).status).toBe(status);
    expect((err as LedgerApiError).cantonError?.code).toBe(error.code);
  });

  it("rejects with the text body when the participant has no such route", async () => {
    const { client } = respond(404, "The requested resource could not be found.");
    const err = await client.getPreferredPackages(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerApiError);
    expect((err as LedgerApiError).cantonError).toBeUndefined();
    expect((err as LedgerApiError).responseBody).toBe(
      "The requested resource could not be found.",
    );
  });
});

describe("Ledger.getPreferredPackages", () => {
  const ledger = () => new Ledger({ token: TEST_TOKEN, httpBaseUrl: BASE_URL });

  it("POSTs the request and returns the response unchanged", async () => {
    const response: GetPreferredPackagesResponse = {
      packageReferences: [reference("lib", "2.0.0"), reference("model", "1.0.0")],
      synchronizerId: "sync::1",
    };
    const { calls } = respond(200, JSON.stringify(response));
    await expect(ledger().getPreferredPackages(request)).resolves.toEqual(response);
    const call = onlyCall(calls);
    expect(call.url).toBe(`${BASE_URL}/v2/interactive-submission/preferred-packages`);
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual(request);
  });

  it("rejects with the Canton code when no package is vetted", async () => {
    const error = cantonError("NO_PREFERRED_PACKAGES_FOUND", 9);
    respond(400, JSON.stringify(error));
    const err = await ledger().getPreferredPackages(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerApiError);
    expect((err as LedgerApiError).cantonError?.code).toBe(error.code);
  });
});

describe("isNoPreferredPackage", () => {
  it.each<[string, unknown, boolean]>([
    ["NO_PREFERRED_PACKAGES_FOUND as a payload", cantonError("NO_PREFERRED_PACKAGES_FOUND", 9), true],
    ["PACKAGE_NAMES_NOT_FOUND as a payload", cantonError("PACKAGE_NAMES_NOT_FOUND", 11), true],
    [
      "NO_PREFERRED_PACKAGES_FOUND under a cantonError property",
      { cantonError: cantonError("NO_PREFERRED_PACKAGES_FOUND", 9) },
      true,
    ],
    ["another Canton code", cantonError("DEPRECATED_API_DISABLED", 8), false],
    ["a plain Error that names the code", new Error("NO_PREFERRED_PACKAGES_FOUND"), false],
    ["a string", "PACKAGE_NAMES_NOT_FOUND", false],
    ["null", null, false],
    ["undefined", undefined, false],
  ])("reads %s as %s", (_, value, expected) => {
    expect(isNoPreferredPackage(value)).toBe(expected);
  });

  it("reads a LedgerApiError from the client", async () => {
    respond(400, JSON.stringify(cantonError("NO_PREFERRED_PACKAGES_FOUND", 9)));
    const err = await new TypedHttpClient({ token: TEST_TOKEN, baseUrl: BASE_URL })
      .getPreferredPackages(request)
      .catch((e: unknown) => e);
    expect(isNoPreferredPackage(err)).toBe(true);
  });
});

describe("preferredReferenceOf", () => {
  const references = [reference("lib", "2.0.0"), reference("model", "1.0.0")];

  it("finds the reference by name, in any position", () => {
    expect(preferredReferenceOf(references, "model")).toEqual(reference("model", "1.0.0"));
    expect(preferredReferenceOf(references, "lib")).toEqual(reference("lib", "2.0.0"));
  });

  it.each<[string, readonly PackageReference[]]>([
    ["an empty answer", []],
    ["an answer for other names only", [reference("lib", "2.0.0")]],
  ])("throws on %s", (_, refs) => {
    expect(() => preferredReferenceOf(refs, "model")).toThrow(
      "preferred-packages returned no reference for model",
    );
  });
});

describe("Ledger.getPreferredPackage", () => {
  const ledger = () => new Ledger({ token: TEST_TOKEN, httpBaseUrl: BASE_URL });
  const parties = ["alice::1220aa", "bob::1220bb"];

  it("asks for the one name and the given parties", async () => {
    const { calls } = respond(
      200,
      JSON.stringify({ packageReferences: [reference("model", "1.0.0")], synchronizerId: "sync::1" }),
    );
    await ledger().getPreferredPackage("model", parties);
    expect(JSON.parse(String(onlyCall(calls).init.body))).toEqual({
      packageVettingRequirements: [{ parties, packageName: "model" }],
    });
  });

  it("gives the reference with the requested name", async () => {
    respond(
      200,
      JSON.stringify({
        packageReferences: [reference("lib", "2.0.0"), reference("model", "1.0.0")],
        synchronizerId: "sync::1",
      }),
    );
    await expect(ledger().getPreferredPackage("model", parties)).resolves.toEqual({
      kind: "vetted",
      reference: reference("model", "1.0.0"),
    });
  });

  it.each<[string, number, JsCantonError]>([
    ["no vetted package", 400, cantonError("NO_PREFERRED_PACKAGES_FOUND", 9)],
    ["an unknown package name", 404, cantonError("PACKAGE_NAMES_NOT_FOUND", 11)],
  ])("gives none for %s", async (_, status, error) => {
    respond(status, JSON.stringify(error));
    await expect(ledger().getPreferredPackage("model", parties)).resolves.toEqual({ kind: "none" });
  });

  it.each<[string, number, string]>([
    ["another Canton reject", 400, JSON.stringify(cantonError("DEPRECATED_API_DISABLED", 8))],
    ["a participant with no such route", 404, "The requested resource could not be found."],
    ["a server error", 500, "Internal Server Error"],
  ])("rejects with a LedgerApiError on %s", async (_, status, body) => {
    respond(status, body);
    await expect(ledger().getPreferredPackage("model", parties)).rejects.toBeInstanceOf(
      LedgerApiError,
    );
  });

  it("rejects when the answer has no reference for the name", async () => {
    respond(
      200,
      JSON.stringify({ packageReferences: [reference("lib", "2.0.0")], synchronizerId: "sync::1" }),
    );
    await expect(ledger().getPreferredPackage("model", parties)).rejects.toThrow(
      "preferred-packages returned no reference for model",
    );
  });
});
