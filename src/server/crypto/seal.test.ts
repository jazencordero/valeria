// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seal, unseal } from "./seal";

const FAKE_SECRET = "test-only-fake-seal-secret-not-real";
const PLAIN = "moodle-token-abc123";

function flipByte(part: string): string {
  const bytes = Buffer.from(part, "base64url");
  bytes[0] ^= 0x01;
  return bytes.toString("base64url");
}

function withPart(sealed: string, index: number, change: (part: string) => string): string {
  const parts = sealed.split(".");
  parts[index] = change(parts[index]);
  return parts.join(".");
}

describe("seal", () => {
  beforeEach(() => {
    vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round trips", () => {
    expect(unseal(seal(PLAIN))).toBe(PLAIN);
    expect(unseal(seal(""))).toBe("");
    expect(unseal(seal("ünïcødé ✓"))).toBe("ünïcødé ✓");
  });

  it("writes v1.<nonce>.<ciphertext>.<tag> in base64url", () => {
    const parts = seal(PLAIN).split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    for (const part of parts.slice(1)) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(parts[1], "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[3], "base64url")).toHaveLength(16);
  });

  it("gives a different result each time for the same text", () => {
    const a = seal(PLAIN);
    const b = seal(PLAIN);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it.each([
    ["nonce", 1],
    ["ciphertext", 2],
    ["tag", 3],
  ])("fails when a byte of the %s is flipped", (_name, index) => {
    const tampered = withPart(seal(PLAIN), index, flipByte);
    expect(() => unseal(tampered)).toThrow(/seal:/);
  });

  it("fails with a different secret", () => {
    const sealed = seal(PLAIN);
    vi.stubEnv("KEY_SEAL_SECRET", "another-fake-secret");
    expect(() => unseal(sealed)).toThrow(/failed authentication/);
  });

  it("rejects a wrong version", () => {
    const sealed = withPart(seal(PLAIN), 0, () => "v2");
    expect(() => unseal(sealed)).toThrow(/unsupported sealed value version/);
  });

  it("rejects the wrong number of parts", () => {
    const sealed = seal(PLAIN);
    expect(() => unseal(sealed.split(".").slice(0, 3).join("."))).toThrow(/4 parts, got 3/);
    expect(() => unseal(`${sealed}.extra`)).toThrow(/4 parts, got 5/);
    expect(() => unseal("")).toThrow(/4 parts, got 1/);
  });

  it("rejects malformed parts", () => {
    const sealed = seal(PLAIN);
    expect(() => unseal(withPart(sealed, 1, (p) => `${p}!`))).toThrow(/malformed nonce/);
    expect(() => unseal(withPart(sealed, 1, (p) => p.slice(2)))).toThrow(/nonce of the wrong length/);
    expect(() => unseal(withPart(sealed, 3, (p) => p.slice(2)))).toThrow(/tag of the wrong length/);
  });

  it("never puts the plaintext, the secret or the sealed value in an error", () => {
    const sealed = seal(PLAIN);
    const bad = [
      withPart(sealed, 2, flipByte),
      withPart(sealed, 0, () => "v9"),
      `${sealed}.x`,
      withPart(sealed, 1, (p) => `${p}!`),
    ];
    for (const value of bad) {
      let message = "";
      try {
        unseal(value);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(PLAIN);
      expect(message).not.toContain(FAKE_SECRET);
      expect(message).not.toContain(value);
    }
  });

  it("throws a clear error when the secret is missing, at call time", () => {
    vi.stubEnv("KEY_SEAL_SECRET", "");
    expect(() => seal(PLAIN)).toThrow("seal: KEY_SEAL_SECRET is not set");
    vi.stubEnv("KEY_SEAL_SECRET", undefined);
    expect(() => seal(PLAIN)).toThrow("seal: KEY_SEAL_SECRET is not set");
  });
});
