import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  applyProjectScheduleSourceOverride,
  ProjectScheduleRepositoryError,
} from "@/lib/project-schedule/repository";
import {
  declaredProjectScheduleBodyTooLarge,
  projectScheduleError,
  projectScheduleJson,
  projectScheduleRequestIsJson,
  ProjectScheduleRequestBodyTooLarge,
  readProjectScheduleJson,
} from "@/lib/project-schedule/request";
import {
  isProjectScheduleSourceEntryId,
  PROJECT_SCHEDULE_SOURCE_OVERRIDE_ACTIONS,
  type ProjectScheduleSourceOverrideAction,
} from "@/lib/project-schedule/types";
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 1_024;

function parseAction(body: Record<string, unknown>): ProjectScheduleSourceOverrideAction | null {
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "action" || typeof body.action !== "string") return null;
  return PROJECT_SCHEDULE_SOURCE_OVERRIDE_ACTIONS.includes(body.action as ProjectScheduleSourceOverrideAction)
    ? body.action as ProjectScheduleSourceOverrideAction
    : null;
}

async function sourceEntryId(context: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await context.params;
  return isProjectScheduleSourceEntryId(entryId) ? entryId : null;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ entryId: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return projectScheduleError(403, "forbidden", "This request is not allowed.");
  }
  if (!isAuthorizedActorRequest(request, "admin")) {
    return projectScheduleError(403, "role_forbidden", "Only Administrators can change source schedule entries.");
  }
  const session = getErpSession(request);
  if (!session || session.user.role !== "admin") {
    return projectScheduleError(403, "admin_session_required", "An Administrator session is required for this action.");
  }
  if ([...request.nextUrl.searchParams.keys()].length) {
    return projectScheduleError(400, "invalid_request", "Source entry actions do not accept query parameters.");
  }
  const entryId = await sourceEntryId(context);
  if (!entryId) {
    return projectScheduleError(400, "invalid_entry_id", "The Weekly Schedule source entry ID is invalid.");
  }
  if (!projectScheduleRequestIsJson(request)) {
    return projectScheduleError(415, "unsupported_media_type", "Send the source entry action as JSON.");
  }
  if (declaredProjectScheduleBodyTooLarge(request, MAX_JSON_SIZE)) {
    return projectScheduleError(413, "request_too_large", "The source entry action is too large.");
  }

  try {
    const action = parseAction(await readProjectScheduleJson(request, MAX_JSON_SIZE));
    if (!action) {
      return projectScheduleError(400, "invalid_action", "Choose a valid source entry action.");
    }
    const override = await applyProjectScheduleSourceOverride(entryId, action, session.user.displayName);
    return projectScheduleJson({ data: { entryId, override } });
  } catch (error) {
    if (error instanceof ProjectScheduleRepositoryError) {
      return projectScheduleError(error.status, error.code, error.message);
    }
    if (error instanceof ProjectScheduleRequestBodyTooLarge) {
      return projectScheduleError(413, "request_too_large", "The source entry action is too large.");
    }
    if (error instanceof SyntaxError) {
      return projectScheduleError(400, "invalid_json", "The source entry action is invalid.");
    }
    return projectScheduleError(500, "source_override_failed", "The source entry action could not be saved.");
  }
}
