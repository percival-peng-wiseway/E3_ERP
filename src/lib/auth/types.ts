export const ERP_ROLES = ["admin", "pm", "sales", "specialist"] as const;

export type ErpRole = (typeof ERP_ROLES)[number];

export type ErpUser = {
  username: string;
  displayName: string;
  role: ErpRole;
};

export type ErpSession = {
  user: ErpUser;
  expiresAt: number;
};

export const ERP_ROLE_LABELS: Record<ErpRole, string> = {
  admin: "Administrator",
  pm: "Project Manager",
  sales: "Sales",
  specialist: "Specialist",
};
