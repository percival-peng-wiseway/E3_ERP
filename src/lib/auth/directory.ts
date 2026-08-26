import type { ErpUser } from "@/lib/auth/types";

export const ERP_USERS: readonly ErpUser[] = [
  { username: "percival", displayName: "Percival", role: "admin" },
  { username: "steve", displayName: "Steve", role: "admin" },
  { username: "jerry", displayName: "Jerry", role: "admin" },
  { username: "jiaqi", displayName: "Jiaqi", role: "admin" },
  { username: "wendy", displayName: "Wendy", role: "pm" },
  { username: "kevin", displayName: "Kevin", role: "pm" },
  { username: "daniel", displayName: "Daniel", role: "pm" },
  { username: "sam", displayName: "Sam", role: "sales" },
  { username: "ruihan", displayName: "Ruihan", role: "sales" },
  { username: "hogan", displayName: "Hogan", role: "pm" },

] as const;

export const ERP_USERNAMES = ERP_USERS.map((user) => user.username);

const USER_BY_USERNAME = new Map(ERP_USERS.map((user) => [user.username, user]));

export function normalizeErpUsername(value: string) {
  return value.trim().toLocaleLowerCase("en-AU");
}

export function findErpUser(username: string): ErpUser | null {
  return USER_BY_USERNAME.get(normalizeErpUsername(username)) || null;
}
