import { timingSafeEqual } from "node:crypto";

const PASSWORD_ITERATIONS = 120_000;
const PASSWORD_BYTES = 32;

export async function verifyPbkdf2Password(password: string, salt: string, expectedHash: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const candidate = Buffer.from(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: Buffer.from(salt, "base64url"),
    iterations: PASSWORD_ITERATIONS,
  }, key, PASSWORD_BYTES * 8));
  const expected = Buffer.from(expectedHash, "base64url");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
