export const PROJECT_SCHEDULE_STATUSES = ["scheduled", "completed"] as const;

export type ProjectScheduleStatus = (typeof PROJECT_SCHEDULE_STATUSES)[number];

export interface ProjectScheduleJob {
  id: string;
  title: string;
  scheduledDate: string;
  startTime: string | null;
  endTime: string | null;
  assignee: string;
  location: string;
  notes: string;
  status: ProjectScheduleStatus;
  createdAt: string;
  updatedAt: string;
}

export type ProjectScheduleCreateInput = Pick<
  ProjectScheduleJob,
  "title" | "scheduledDate" | "startTime" | "endTime" | "assignee" | "location" | "notes"
>;

export type ProjectSchedulePatchInput = Partial<Pick<
  ProjectScheduleJob,
  "title" | "scheduledDate" | "startTime" | "endTime" | "assignee" | "location" | "notes" | "status"
>>;
