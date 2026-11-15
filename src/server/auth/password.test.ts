// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hashPassword, PasswordInvalid, passwordProblem, verifyPassword } from "./password";

// Invented passwords only.
const PASSWORD = "correct horse";

describe("hashPassword and verifyPassword", () => {
  it("hashes to one self-describing scrypt string and verifies it", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("correct horsf", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("uses a fresh salt every time", async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(a).not.toBe(b);
    expect(a.split("$")[4]).not.toBe(b.split("$")[4]);
  });

  it("treats the same password typed in another Unicode form as the same", async () => {
    const hash = await hashPassword("pässword");
    expect(await verifyPassword("pässword", hash)).toBe(true);
  });

  it("says no to a malformed or foreign hash, without throwing", async () => {
    for (const stored of ["", "bcrypt$x", "scrypt$3$8$1$abc$def", "scrypt$1099511627776$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA", "scrypt$32768$8$1$!!$!!"]) {
      expect(await verifyPassword(PASSWORD, stored)).toBe(false);
    }
  });

  it("allows 5 to 200 characters and nothing else is a rule", async () => {
    expect(passwordProblem("abcd")).toBe("Use at least 5 characters.");
    expect(passwordProblem("abcde")).toBeNull();
    expect(passwordProblem("     ")).toBeNull();
    expect(passwordProblem("x".repeat(200))).toBeNull();
    expect(passwordProblem("x".repeat(201))).toBe("Use at most 200 characters.");
    await expect(hashPassword("abcd")).rejects.toBeInstanceOf(PasswordInvalid);
  });
});
