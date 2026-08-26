import "server-only";

import { normalizeErpUsername } from "@/lib/auth/directory";
import { DUMMY_PASSWORD_VERIFIER } from "@/lib/auth/legacy-credentials";
import { verifyScryptPassword } from "@/lib/auth/password-crypto";
import { findErpUserAccount } from "@/lib/auth/user-repository";
import type { ErpRole, ErpUser } from "@/lib/auth/types";

export async function verifyErpCredentials(username: string, password: string): Promise<{
  user: ErpUser;
  sessionVersion: number;
} | null> {
  const normalizedUsername = normalizeErpUsername(username);
  const account = await findErpUserAccount(normalizedUsername);
  const verifier = account?.active ? account : DUMMY_PASSWORD_VERIFIER;
  const passwordMatches = await verifyScryptPassword(password, verifier.salt, verifier.passwordHash);
  if (!account?.active || !passwordMatches) return null;
  return {
    user: { username: account.username, displayName: account.displayName, role: account.role },
    sessionVersion: account.sessionVersion,
  };
}

export function erpRoleCanActAs(role: ErpRole, actorRole: string) {
  const effectiveRole = role === "specialist" ? "sales" : role;
  return role === "admin" || effectiveRole === actorRole;
}
