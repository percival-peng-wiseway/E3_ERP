import "server-only";

import { findErpUser, normalizeErpUsername } from "@/lib/auth/directory";
import { verifyPbkdf2Password } from "@/lib/auth/password-crypto";
import type { ErpRole, ErpUser } from "@/lib/auth/types";

type PasswordVerifier = {
  salt: string;
  passwordHash: string;
};

// Only salted password verifiers are committed. Plain-text passwords never enter
// the browser bundle or the repository.
const PASSWORD_VERIFIERS: Readonly<Record<string, PasswordVerifier>> = {
  jerry: {
    salt: "u6ZRfR-mSgxr4jE8rIgG0g",
    passwordHash: "Cr2h7I37kM5xA2AEZWpB9YcCXUh6CDIoyzeFopTsKtE",
  },
  jiaqi: {
    salt: "UABndEoYw_a6x478-F1kGQ",
    passwordHash: "4l9RAwlqlhylNqDAztLNy1UCM2O_QYH12yO6vrOHOx8",
  },
  wendy: {
    salt: "r3bn02cgBdgnQArpYHCjQg",
    passwordHash: "DA5onw2ukI-53ojGaNXQ6233txXROoko4lqMjSDEfj4",
  },
  kevin: {
    salt: "b2NnVZYS4nobKNj9rgJaQA",
    passwordHash: "mOR7Iyx0uj9BaRYxLbCErN0LZX3UmVpWkcXUkgNgnA0",
  },
  daniel: {
    salt: "s88y0DC3Ogk_EA0zkDyf5A",
    passwordHash: "I1SzcuiJ30Vdu12NIizK0O2ZRicLEHfnrK_BTXwi9RA",
  },
  sam: {
    salt: "ojR3tLtbnBHl8PQotDZL5w",
    passwordHash: "Aybikpgn__69DEOex7PXODFNebD9I710WBLyfJRDOlU",
  },
  ruihan: {
    salt: "eElq7KgqFzN-JESkw1DDDg",
    passwordHash: "hVOEYsSD4OfcaMpzWlGja3L8r84KcxM7sWpvI4-ED9o",
  },
  hogan: {
    salt: "p_ZBcrZWF0yiciHRoyW4rQ",
    passwordHash: "TjC83PC7MoXfiGwW4JzAhWGnMCtjFJqQkgR4-FKGEOU",
  },
} as const;

const DUMMY_VERIFIER = PASSWORD_VERIFIERS.jerry;

export async function verifyErpCredentials(username: string, password: string): Promise<ErpUser | null> {
  const normalizedUsername = normalizeErpUsername(username);
  const user = findErpUser(normalizedUsername);
  const verifier = PASSWORD_VERIFIERS[normalizedUsername] || DUMMY_VERIFIER;
  const passwordMatches = await verifyPbkdf2Password(password, verifier.salt, verifier.passwordHash);
  return user && passwordMatches ? user : null;
}

export function erpRoleCanActAs(role: ErpRole, actorRole: string) {
  return role === "admin" || role === actorRole;
}
