export const ERP_ROLES = ["admin", "pm", "sales", "specialist"] as const;
export const ERP_ASSIGNABLE_ROLES = ["admin", "pm", "sales"] as const;

export type ErpRole = (typeof ERP_ROLES)[number];

export type ErpUser = {
  username: string;
  displayName: string;
  role: ErpRole;
};

export type ManagedErpUser = ErpUser & {
  active: boolean;
  credentialsConfigured: boolean;
  sessionVersion: number;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type ErpSession = {
  user: ErpUser;
  expiresAt: number;
};

export const ERP_ROLE_LABELS: Record<ErpRole, string> = {
  admin: "Administrator",
  pm: "Project Manager",
  sales: "Sales",
  specialist: "Sales",
};
