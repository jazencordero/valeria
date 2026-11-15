/*
 * Passwords (M5-14): scrypt from node:crypto, no dependency.
 *
 *   hashPassword(password)          -> "scrypt$32768$8$1$<salt>$<key>"   (base64url, no padding)
 *   verifyPassword(password, hash)  -> true | false
 *
 * One self-describing string per user: the cost parameters travel with the hash, so they can be
 * raised later and old hashes still verify. A fresh 16-byte random salt per hash, a 64-byte key,
 * N = 2^15, r = 8, p = 1 (about 32 MiB and a few tens of ms per hash). The compare is constant
 * time. scrypt runs on libuv's thread pool (the async form), so it does not block the server.
 *
 * The only rule is length: 5 to 200 characters (counted as code points, after NFC so the same
 * password typed on two devices gives the same bytes). Nothing here logs a password or a hash.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const PASSWORD_MIN = 5;
export const PASSWORD_MAX = 200;

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
/** Bounds for parameters read back from a stored hash, so a bad row cannot ask for gigabytes. */
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** scrypt needs 128 * N * r bytes; leave room above that (Node's default cap is 32 MiB). */
const maxmemFor = (n: number, r: number) => 128 * n * r * 2;

const normalise = (password: string) => password.normalize("NFC");

/** The one sentence to show when a new password breaks the length rule, else null. */
export function passwordProblem(password: string): string | null {
  const length = [...normalise(password)].length;
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

export class PasswordInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordInvalid";
  }
}

/** Hashes a new password. Throws `PasswordInvalid` (with the sentence to show) when it breaks the length rule. */
export async function hashPassword(password: string): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new PasswordInvalid(problem);
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(normalise(password), salt, KEY_BYTES, { N, r: R, p: P, maxmem: maxmemFor(N, R) });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

type Parsed = { n: number; r: number; p: number; salt: Buffer; key: Buffer };

const B64URL = /^[A-Za-z0-9_-]+$/;

function parse(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [n, r, p] = parts.slice(1, 4).map((v) => (/^\d{1,8}$/.test(v) ? Number(v) : NaN));
  if (!(n >= 2 && n <= MAX_N && (n & (n - 1)) === 0)) return null;
  if (!(r >= 1 && r <= MAX_R) || !(p >= 1 && p <= MAX_P)) return null;
  if (!B64URL.test(parts[4]) || !B64URL.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const key = Buffer.from(parts[5], "base64url");
  if (salt.length < 8 || key.length < 32) return null;
  return { n, r, p, salt, key };
}

/**
 * Whether `password` matches `stored`. A malformed `stored` gives false (never throws), after the
 * same amount of work as a real check would take, so the answer's timing says nothing either.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  const use = parsed ?? { n: N, r: R, p: P, salt: randomBytes(SALT_BYTES), key: randomBytes(KEY_BYTES) };
  const key = await scrypt(normalise(password), use.salt, use.key.length, {
    N: use.n,
    r: use.r,
    p: use.p,
    maxmem: maxmemFor(use.n, use.r),
  });
  return timingSafeEqual(key, use.key) && parsed !== null;
}
