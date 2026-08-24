import {
  AgentSettingsError,
  clearAgentSettings,
  publicAgentSettings,
  saveAgentSettings,
} from "@/lib/agent/settings";
import {
  AgentRequestBodyTooLarge,
  readLimitedAgentJson,
  requestHasJsonContentType,
} from "@/lib/agent/request";
import { isAuthorizedActorRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_SETTINGS_BODY = 16 * 1024;

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(data, { ...init, headers });
}

function error(status: number, code: string, message: string) {
  return json({ error: { code, message } }, { status });
}

function settingsInput(value: unknown): { apiKey?: string; baseUrl: string; model: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["apiKey", "baseUrl", "model"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (typeof body.baseUrl !== "string" || typeof body.model !== "string") return null;
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") return null;
  return {
    ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
    baseUrl: body.baseUrl,
    model: body.model,
  };
}

export async function GET() {
  try {
    return json({ data: await publicAgentSettings() });
  } catch (settingsError) {
    console.error("Unable to load Agent settings", settingsError instanceof Error ? settingsError.message : settingsError);
    return error(500, "settings_unavailable", "Agent settings are temporarily unavailable.");
  }
}

export async function PUT(request: Request) {
  if (!isAuthorizedActorRequest(request, "admin")) {
    return error(403, "forbidden", "Administrator access is required to change Agent settings.");
  }
  if (!requestHasJsonContentType(request)) {
    return error(415, "json_required", "Agent settings accept a JSON request body only.");
  }

  try {
    const input = settingsInput(await readLimitedAgentJson(request, MAX_SETTINGS_BODY));
    if (!input) return error(400, "invalid_settings", "Complete the API settings with valid fields.");
    return json({ data: await saveAgentSettings(input) });
  } catch (settingsError) {
    if (settingsError instanceof AgentRequestBodyTooLarge) {
      return error(413, "request_too_large", "Agent settings cannot exceed 16 KiB.");
    }
    if (settingsError instanceof AgentSettingsError) {
      return error(settingsError.status, settingsError.code, settingsError.message);
    }
    if (settingsError instanceof SyntaxError) {
      return error(400, "invalid_json", "The request body must be valid JSON.");
    }
    console.error("Unable to save Agent settings", settingsError instanceof Error ? settingsError.message : settingsError);
    return error(500, "settings_unavailable", "Agent settings could not be saved.");
  }
}

export async function DELETE(request: Request) {
  if (!isAuthorizedActorRequest(request, "admin")) {
    return error(403, "forbidden", "Administrator access is required to clear Agent settings.");
  }
  try {
    return json({ data: await clearAgentSettings() });
  } catch (settingsError) {
    console.error("Unable to clear Agent settings", settingsError instanceof Error ? settingsError.message : settingsError);
    return error(500, "settings_unavailable", "Agent settings could not be cleared.");
  }
}
