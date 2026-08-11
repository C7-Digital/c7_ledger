import {
  categoryOf,
  isRetryable,
  resourcesOf,
  cantonErrorOf,
  type CantonErrorCategory,
} from "./cantonError";
import { isCantonError, type JsCantonError } from "./types";
import { LedgerApiError } from "./client";

/** A payload with the required fields filled in, overridable per test. */
function payload(over: Partial<JsCantonError> = {}): JsCantonError {
  return {
    code: "SOME_CODE",
    cause: "something happened",
    context: {},
    errorCategory: 8,
    ...over,
  };
}

/**
 * The rejection that motivated this module, captured from a 7LOCK TestNet
 * smoke run on 2026-08-10 when a loan recall lost a race. Note `errorCategory:
 * 11` — Canton had already classified it; the consumer was reading the `code`
 * string instead.
 */
const CONTRACT_NOT_FOUND: JsCantonError = {
  code: "CONTRACT_NOT_FOUND",
  cause:
    "Contract could not be found with id 001b68f5aa3e5c9d4f2b1a0e7c6d5b4a39281706f5e4d3c2b1a09876543210fed",
  context: { participant: "participant1" },
  errorCategory: 11,
  grpcCodeValue: 5,
};

describe("categoryOf", () => {
  it.each<[number, CantonErrorCategory]>([
    [1, "transient"],
    [2, "contention"],
    [3, "deadline"],
    [4, "internal"],
    [5, "security"],
    [6, "unauthenticated"],
    [7, "permission"],
    [8, "invalidRequest"],
    [9, "invalidState"],
    [10, "resourceExists"],
    [11, "resourceMissing"],
    [12, "seekAfterEnd"],
    [13, "degraded"],
    [14, "unsupported"],
  ])("maps errorCategory %i to %s", (int, name) => {
    expect(categoryOf(payload({ errorCategory: int }))).toBe(name);
  });

  it("classifies the captured TestNet rejection as resourceMissing", () => {
    expect(categoryOf(CONTRACT_NOT_FOUND)).toBe("resourceMissing");
  });

  it("returns null for a category this build does not know", () => {
    // A newer Canton. Reporting null keeps a caller's switch from mis-filing a
    // case that did not exist when the table was written.
    expect(categoryOf(payload({ errorCategory: 99 }))).toBeNull();
    expect(categoryOf(payload({ errorCategory: 0 }))).toBeNull();
  });
});

describe("isRetryable", () => {
  it.each<[CantonErrorCategory, number]>([
    ["transient", 1],
    ["contention", 2],
    ["deadline", 3],
    ["seekAfterEnd", 12],
  ])("says %s (category %i) is retryable", (_name, int) => {
    expect(isRetryable(payload({ errorCategory: int }))).toBe(true);
  });

  it.each([4, 5, 6, 7, 8, 9, 10, 11, 13, 14])(
    "says category %i is not retryable",
    (int) => {
      expect(isRetryable(payload({ errorCategory: int }))).toBe(false);
    }
  );

  it("treats an unknown category as not retryable", () => {
    // Conservative on purpose: retrying an unrecognised failure risks
    // amplifying it.
    expect(isRetryable(payload({ errorCategory: 99 }))).toBe(false);
  });

  it("honours an explicit retryInfo even on a non-retryable category", () => {
    // retryInfo is Canton speaking about this specific occurrence; the
    // category table is its default. The specific wins.
    expect(
      isRetryable(payload({ errorCategory: 9, retryInfo: "1 second" }))
    ).toBe(true);
  });

  it("ignores an empty retryInfo", () => {
    expect(isRetryable(payload({ errorCategory: 9, retryInfo: "  " }))).toBe(
      false
    );
  });
});

describe("the contention allow-list this replaces", () => {
  // The three codes consumers were matching by hand. All are category 2, so
  // `errorCategory === 2` covers them — and covers the contention codes that
  // allow-list never knew about.
  it.each([
    "LOCAL_VERDICT_LOCKED_CONTRACTS",
    "CONTRACT_STATE_CHANGED",
    "INCONSISTENT_CONTRACT_KEY",
  ])("%s is category 2 / contention / retryable", (code) => {
    const e = payload({ code, errorCategory: 2 });
    expect(categoryOf(e)).toBe("contention");
    expect(isRetryable(e)).toBe(true);
  });
});

describe("resourcesOf", () => {
  const withResources = payload({
    errorCategory: 11,
    resources: [
      ["CONTRACT_ID", "001abc"],
      ["PARTY", "alice::122f"],
      ["CONTRACT_ID", "002def"],
    ],
  });

  it("returns every value for a kind, in order", () => {
    expect(resourcesOf(withResources, "CONTRACT_ID")).toEqual([
      "001abc",
      "002def",
    ]);
  });

  it("returns [] for an absent kind rather than undefined", () => {
    // So callers can iterate without a presence check.
    expect(resourcesOf(withResources, "TEMPLATE_ID")).toEqual([]);
  });

  it("returns [] when the payload carries no resources at all", () => {
    expect(resourcesOf(CONTRACT_NOT_FOUND, "CONTRACT_ID")).toEqual([]);
  });

  it("matches the NULLABLE_ prefix Canton applies to optional resources", () => {
    const e = payload({ resources: [["NULLABLE_CONTRACT_KEY", "k1"]] });
    expect(resourcesOf(e, "CONTRACT_KEY")).toEqual(["k1"]);
  });

  it("skips malformed pairs instead of throwing", () => {
    const e = payload({
      // Shapes a hand-built or proxied payload can produce.
      resources: [
        ["CONTRACT_ID"],
        ["CONTRACT_ID", 42],
        "CONTRACT_ID",
        ["CONTRACT_ID", "good"],
      ] as unknown as JsCantonError["resources"],
    });
    expect(resourcesOf(e, "CONTRACT_ID")).toEqual(["good"]);
  });

  it("reads the contract id from data, where scraping prose would guess", () => {
    // The cause sentence is prose Canton may reword; the pair is not.
    const e: JsCantonError = {
      ...CONTRACT_NOT_FOUND,
      resources: [["CONTRACT_ID", "001b68f5aa3e"]],
    };
    expect(resourcesOf(e, "CONTRACT_ID")).toEqual(["001b68f5aa3e"]);
  });
});

describe("cantonErrorOf", () => {
  it("passes a bare payload through", () => {
    expect(cantonErrorOf(CONTRACT_NOT_FOUND)).toBe(CONTRACT_NOT_FOUND);
  });

  it("reads the payload off a LedgerApiError from this package", () => {
    const err = new LedgerApiError(404, "Not Found", CONTRACT_NOT_FOUND);
    expect(cantonErrorOf(err)).toEqual(CONTRACT_NOT_FOUND);
    // And the round trip is the point: category without touching the string.
    expect(categoryOf(cantonErrorOf(err)!)).toBe("resourceMissing");
  });

  it("reads the payload off any value exposing `cantonError`", () => {
    // The seam for a wallet-gateway decoder: it peels its own envelopes and
    // publishes the payload under that name. Structural, so no dependency is
    // needed in either direction — and so it survives a duplicated copy of
    // this package in a pnpm tree, where `instanceof` would not.
    class WalletGatewayError extends Error {
      constructor(readonly cantonError: JsCantonError) {
        super("gateway rejected");
      }
    }
    expect(cantonErrorOf(new WalletGatewayError(CONTRACT_NOT_FOUND))).toBe(
      CONTRACT_NOT_FOUND
    );
  });

  it("declines a LedgerApiError whose body was not a Canton payload", () => {
    // A proxy's HTML page carries no application meaning; saying so lets the
    // caller classify it as a transport failure instead.
    const err = new LedgerApiError(403, "Forbidden", "<html>403 Forbidden</html>");
    expect(cantonErrorOf(err)).toBeNull();
  });

  it.each([
    ["a plain Error", new Error("boom")],
    ["a string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 500],
    ["an empty object", {}],
    ["an array", [1, 2, 3]],
  ])("declines %s", (_label, value) => {
    expect(cantonErrorOf(value)).toBeNull();
  });

  it("does NOT walk transport envelopes", () => {
    // Extraction is the transport's job. A value that still needs unwrapping
    // has not reached the layer that knows how it was wrapped, and guessing
    // here is what this module exists to stop.
    const wrapped = {
      error: { code: 500, message: "", data: JSON.stringify(CONTRACT_NOT_FOUND) },
    };
    expect(cantonErrorOf(wrapped)).toBeNull();
  });
});

describe("isCantonError checks types, not just key presence", () => {
  it("accepts a well-formed payload", () => {
    expect(isCantonError(CONTRACT_NOT_FOUND)).toBe(true);
  });

  it("rejects the shape whose `cause` is a nested errors array", () => {
    // A real JSON-API rejection shape. Under key-presence-only narrowing this
    // passed, and `${code}: ${cause}` then rendered "[object Object]" in the
    // one field meant to explain the failure. The sentence it does carry lives
    // in `errors[]`, and a caller's own formatter finds it — but only if this
    // guard declines first.
    expect(
      isCantonError({
        code: "FAILED_PRECONDITION",
        cause: { errors: [{ message: "Lock.expiresAt not exceeded" }] },
        context: {},
        errorCategory: 9,
      })
    ).toBe(false);
  });

  it("rejects a numeric code (a JSON-RPC or HTTP status, not a Canton code)", () => {
    expect(
      isCantonError({ code: 500, cause: "boom", context: {}, errorCategory: 4 })
    ).toBe(false);
  });

  it("rejects a payload missing errorCategory", () => {
    // Required by the schema, and the field every accessor here keys on.
    expect(isCantonError({ code: "X", cause: "y", context: {} })).toBe(false);
  });

  it("rejects a payload whose context is present but null", () => {
    expect(
      isCantonError({
        code: "X",
        cause: "y",
        context: null,
        errorCategory: 8,
      })
    ).toBe(false);
  });
});
