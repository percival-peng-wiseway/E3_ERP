import { NextRequest } from "next/server";
import {
  createProjectScheduleJob,
  listProjectScheduleJobs,
  listProjectScheduleSourceOverrides,
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
  parseProjectScheduleCreate,
  projectScheduleDate,
} from "@/lib/project-schedule/validation";
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 32 * 1024;

export async function GET(request: NextRequest) {
  const parameters = request.nextUrl.searchParams;
  if ([...parameters.keys()].some((key) => key !== "from" && key !== "to")
    || parameters.getAll("from").length !== 1
    || parameters.getAll("to").length !== 1) {
    return projectScheduleError(400, "invalid_date_range", "Provide one from date and one to date.");
  }
  const from = parameters.get("from");
  const to = parameters.get("to");
  if (!projectScheduleDate(from) || !projectScheduleDate(to) || from > to) {
    return projectScheduleError(400, "invalid_date_range", "Choose a valid schedule date range.");
  }
  try {
    const [jobs, overrides] = await Promise.all([
      listProjectScheduleJobs(from, to),
      listProjectScheduleSourceOverrides(),
    ]);
    return projectScheduleJson({ data: { jobs, overrides } });
  } catch (error) {
    if (error instanceof ProjectScheduleRepositoryError) {
      return projectScheduleError(error.status, error.code, error.message);
    }
    return projectScheduleError(500, "storage_unavailable", "Project Schedule is temporarily unavailable.");
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) {
    return projectScheduleError(403, "forbidden", "This request is not allowed.");
  }
  if (!isAuthorizedActorRequest(request, "pm")) {
    return projectScheduleError(403, "role_forbidden", "Only Project Managers or Administrators can create schedule jobs.");
  }
  if (!projectScheduleRequestIsJson(request)) {
    return projectScheduleError(415, "unsupported_media_type", "Send the schedule job as JSON.");
  }
  if (declaredProjectScheduleBodyTooLarge(request, MAX_JSON_SIZE)) {
    return projectScheduleError(413, "request_too_large", "The schedule job is too large.");
  }
  try {
    const input = parseProjectScheduleCreate(await readProjectScheduleJson(request, MAX_JSON_SIZE));
    if (!input) return projectScheduleError(400, "invalid_job", "Complete the schedule job with valid information.");
    const job = await createProjectScheduleJob(input);
    return projectScheduleJson({ data: { job } }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectScheduleRepositoryError) {
      return projectScheduleError(error.status, error.code, error.message);
    }
    if (error instanceof ProjectScheduleRequestBodyTooLarge) {
      return projectScheduleError(413, "request_too_large", "The schedule job is too large.");
    }
    if (error instanceof SyntaxError) {
      return projectScheduleError(400, "invalid_json", "The schedule job request is invalid.");
    }
    return projectScheduleError(500, "create_failed", "The schedule job could not be created.");
  }
}
