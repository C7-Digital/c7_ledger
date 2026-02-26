import { describe, it, expect } from "vitest";
import { sha256 } from "../sha256.js";

describe("sha256", () => {
  it("hashes an empty string", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("hashes 'hello'", () => {
    expect(sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("hashes 'abc'", () => {
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("handles unicode characters", () => {
    const result = sha256("Hello, 世界!");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns consistent results for the same input", () => {
    const input = "test-consistency";
    expect(sha256(input)).toBe(sha256(input));
  });

  it("returns different results for different inputs", () => {
    expect(sha256("input1")).not.toBe(sha256("input2"));
  });
});
