import assert from "node:assert/strict";
import test from "node:test";

const passwordCryptoModule = "./password-crypto.ts";
const { createScryptPasswordVerifier, verifyScryptPassword } = await import(passwordCryptoModule) as typeof import("./password-crypto");

const TEST_SALT = "dGVzdC1zYWx0LWZvci1lM2VycA";
const TEST_HASH = "so9f_TxWpxgFnhd5w1V_r98hGmA95Trs0jp2vX8Ep4c";

test("asynchronous scrypt matches the Node-generated test vector", async () => {
  assert.equal(await verifyScryptPassword("test-only-password", TEST_SALT, TEST_HASH), true);
  assert.equal(await verifyScryptPassword("incorrect", TEST_SALT, TEST_HASH), false);
});

test("new password verifiers use unique salts and verify only the source password", async () => {
  const first = await createScryptPasswordVerifier("temporary-password-123");
  const second = await createScryptPasswordVerifier("temporary-password-123");

  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.passwordHash, second.passwordHash);
  assert.equal(await verifyScryptPassword("temporary-password-123", first.salt, first.passwordHash), true);
  assert.equal(await verifyScryptPassword("different-password", first.salt, first.passwordHash), false);
});
