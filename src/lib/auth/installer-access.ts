/** Explicit allowlist: new modules and all business mutations are denied by default. */
export function installerRequestAllowed(method: string, pathname: string) {
  if (["/api/team-workspace", "/api/team-workspace/files"].includes(pathname)) return ["GET", "POST"].includes(method);
  if (["/api/auth/login", "/api/auth/logout"].includes(pathname)) return method === "POST";
  if (method !== "GET" && method !== "HEAD") return false;
  return ["/", "/login", "/api/auth/session", "/api/timetable"].includes(pathname)
    || /^\/api\/timetable\/projects\/[a-zA-Z0-9-]+$/.test(pathname)
    || /^\/(?:icon|apple-icon|opengraph-image)(?:\/|\.|$)/.test(pathname);
}
