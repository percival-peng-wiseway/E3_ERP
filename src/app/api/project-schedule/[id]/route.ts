import { NextRequest } from "next/server";
import {
  deleteProjectScheduleJob,
  ProjectScheduleRepositoryError,
  updateProjectScheduleJob,
} from "@/lib/project-schedule/repository";
import {
  declaredProjectScheduleBodyTooLarge,
  projectScheduleError,
  projectScheduleJson,
  projectScheduleRequestIsJson,
  ProjectScheduleRequestBodyTooLarge,
  readProjectScheduleBody,
  readProjectScheduleJson,
} from "@/lib/project-schedule/request";
import { parseProjectSchedulePatch } from "@/lib/project-schedule/validation";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 32 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function projectId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return ID_PATTERN.test(id) ? id : null;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return projectScheduleError(403, "forbidden", "This request is not allowed.");
  }
  const id = await projectId(context);
  if (!id) return projectScheduleError(400, "invalid_id", "The schedule job ID is invalid.");
  if (!projectScheduleRequestIsJson(request)) {
    return projectScheduleError(415, "unsupported_media_type", "Send the schedule update as JSON.");
  }
  if (declaredProjectScheduleBodyTooLarge(request, MAX_JSON_SIZE)) {
    return projectScheduleError(413, "request_too_large", "The schedule update is too large.");
  }
  try {
    const patch = parseProjectSchedulePatch(await readProjectScheduleJson(request, MAX_JSON_SIZE));
    if (!patch) return projectScheduleError(400, "invalid_job", "The schedule update is invalid.");
    const job = await updateProjectScheduleJob(id, patch);
    return projectScheduleJson({ data: { job } });
  } catch (error) {
    if (error instanceof ProjectScheduleRepositoryError) {
      return projectScheduleError(error.status, error.code, error.message);
    }
    if (error instanceof ProjectScheduleRequestBodyTooLarge) {
      return projectScheduleError(413, "request_too_large", "The schedule update is too large.");
    }
    if (error instanceof SyntaxError) {
      return projectScheduleError(400, "invalid_json", "The schedule update is invalid.");
    }
    return projectScheduleError(500, "update_failed", "The schedule job could not be updated.");
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return projectScheduleError(403, "forbidden", "This request is not allowed.");
  }
  const id = await projectId(context);
  if (!id) return projectScheduleError(400, "invalid_id", "The schedule job ID is invalid.");
  try {
    const body = await readProjectScheduleBody(request, 1);
    if (body.byteLength) return projectScheduleError(400, "invalid_request", "DELETE does not accept a request body.");
    await deleteProjectScheduleJob(id);
    return projectScheduleJson({ data: { id } });
  } catch (error) {
    if (error instanceof ProjectScheduleRepositoryError) {
      return projectScheduleError(error.status, error.code, error.message);
    }
    if (error instanceof ProjectScheduleRequestBodyTooLarge) {
      return projectScheduleError(400, "invalid_request", "DELETE does not accept a request body.");
    }
    return projectScheduleError(500, "delete_failed", "The schedule job could not be deleted.");
  }
}
