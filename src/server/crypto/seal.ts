import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

if (typeof window !== "undefined") {
  throw new Error("src/server/crypto/seal.ts is server-only; it must not be imported by client code.");
}

/**
 * Seals and unseals a student's Moodle key so it is never stored in plain text.
 *
 * Format: `v1.<nonce>.<ciphertext>.<tag>`, each part base64url.
 * - Cipher: AES-256-GCM, a fresh random 12-byte nonce per call, 16-byte tag.
 * - Key: HKDF-SHA256 over `KEY_SEAL_SECRET`, with the fixed salt and info below.
 *   Changing either string makes every existing sealed value unreadable.
 *
 * This is the only file allowed to read `KEY_SEAL_SECRET`. It is read at call
 * time, never at import time, so `next build` works without it.
 *
 * Errors never include the plaintext, the sealed value or the secret.
 * No key rotation yet; the `v1` prefix leaves room for it.
 */

const VERSION = "v1";
const HKDF_SALT = "ready/moodle-key-seal/salt/v1";
const HKDF_INFO = "ready/moodle-key-seal/aes-256-gcm/v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function deriveKey(): Buffer {
  const secret = process.env.KEY_SEAL_SECRET;
  if (!secret) {
    throw new Error("seal: KEY_SEAL_SECRET is not set");
  }
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

export function seal(plain: string): string {
  const key = deriveKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(VERSION));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce, ciphertext, tag]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function decodePart(part: string, name: string): Buffer {
  if (!BASE64URL.test(part)) {
    throw new Error(`seal: sealed value has a malformed ${name}`);
  }
  return Buffer.from(part, "base64url");
}

export function unseal(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) {
    throw new Error(`seal: sealed value must have 4 parts, got ${parts.length}`);
  }
  const [version, nonceText, ciphertextText, tagText] = parts;
  if (version !== VERSION) {
    throw new Error("seal: unsupported sealed value version");
  }
  const nonce = decodePart(nonceText, "nonce");
  const ciphertext = decodePart(ciphertextText, "ciphertext");
  const tag = decodePart(tagText, "tag");
  if (nonce.length !== NONCE_BYTES) {
    throw new Error("seal: sealed value has a nonce of the wrong length");
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error("seal: sealed value has a tag of the wrong length");
  }

  const key = deriveKey();
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(VERSION));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("seal: sealed value failed authentication (tampered or wrong secret)");
  }
}
