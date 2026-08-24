import { scrypt, timingSafeEqual } from "node:crypto";

const PASSWORD_BYTES = 32;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function deriveScryptHash(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, "base64url"), PASSWORD_BYTES, SCRYPT_OPTIONS, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

export async function verifyScryptPassword(password: string, salt: string, expectedHash: string) {
  const candidate = await deriveScryptHash(password, salt);
  const expected = Buffer.from(expectedHash, "base64url");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
