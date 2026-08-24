import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ERPWorkspace } from "@/components/erp-workspace";
import { ERP_SESSION_COOKIE, readErpSessionToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cookieStore = await cookies();
  const session = readErpSessionToken(cookieStore.get(ERP_SESSION_COOKIE)?.value || "");
  if (!session) redirect("/login");
  return <ERPWorkspace currentUser={session.user} />;
}
