import assert from "node:assert/strict";
import test from "node:test";

const passwordCryptoModule = "./password-crypto.ts";
const { verifyScryptPassword } = await import(passwordCryptoModule) as typeof import("./password-crypto");

const TEST_SALT = "dGVzdC1zYWx0LWZvci1lM2VycA";
const TEST_HASH = "so9f_TxWpxgFnhd5w1V_r98hGmA95Trs0jp2vX8Ep4c";

test("asynchronous scrypt matches the Node-generated test vector", async () => {
  assert.equal(await verifyScryptPassword("test-only-password", TEST_SALT, TEST_HASH), true);
  assert.equal(await verifyScryptPassword("incorrect", TEST_SALT, TEST_HASH), false);
});
