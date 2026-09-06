const REMOTE_READ_ONLY_POST_PATHS = new Set([
  "/api/agent",
  "/api/agent/attachments/status",
  "/api/agent/chat",
]);

type RemoteDataEnvironment = {
  nodeEnv?: string;
  remoteDataReadOnly?: string;
};

/** The remote-data switch protects local development, never production writes. */
export function remoteDataMutationBlocked(
  method: string,
  pathname: string,
  environment: RemoteDataEnvironment,
): boolean {
  if (environment.nodeEnv === "production" || environment.remoteDataReadOnly !== "true") return false;
  if (!pathname.startsWith("/api/")) return false;

  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return false;
  return normalizedMethod !== "POST" || !REMOTE_READ_ONLY_POST_PATHS.has(pathname);
}
