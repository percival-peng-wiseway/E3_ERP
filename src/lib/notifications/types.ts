export const NOTIFICATION_ROLES = ["sales", "specialist", "pm", "admin"] as const;

export type NotificationRole = (typeof NOTIFICATION_ROLES)[number];
export type NotificationRoleFilter = "all" | NotificationRole;
export type NotificationPriority = "urgent" | "high" | "normal";
export type NotificationModule =
  | "payments"
  | "projects"
  | "reimbursements"
  | "inventory"
  | "quotations";

export type WorkspaceNotification = {
  id: string;
  role: NotificationRole;
  priority: NotificationPriority;
  badgeLabel?: string;
  projectCreatedAt?: string;
  ownerName?: string;
  title: string;
  description: string;
  module: NotificationModule;
  entityId?: string;
  actionLabel: string;
};

export type NotificationCounts = Record<NotificationRoleFilter, number>;

export type NotificationsResponse = {
  data: {
    generatedAt: string;
    notifications: WorkspaceNotification[];
    counts: NotificationCounts;
  };
  meta: {
    source: "workspace-live-data";
    warnings: string[];
  };
};
