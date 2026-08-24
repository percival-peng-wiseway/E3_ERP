import assert from "node:assert/strict";
import test from "node:test";

const passwordCryptoModule = "./password-crypto.ts";
const { verifyPbkdf2Password } = await import(passwordCryptoModule) as typeof import("./password-crypto");

const TEST_SALT = "dGVzdC1zYWx0LWZvci1lM2VycA";
const TEST_HASH = "5fWVyu-p7N-eCmT1HFY6NV-nGU4OuCraIpK--b1R2Qc";

test("Web Crypto PBKDF2 matches the Node-generated test vector", async () => {
  assert.equal(await verifyPbkdf2Password("test-only-password", TEST_SALT, TEST_HASH), true);
  assert.equal(await verifyPbkdf2Password("incorrect", TEST_SALT, TEST_HASH), false);
});
