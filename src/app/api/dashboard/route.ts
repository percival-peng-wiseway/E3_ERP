import { NextResponse } from "next/server";
import { buildDashboard, getERPProvider } from "@/lib/erp";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const provider = getERPProvider();
    const data = await buildDashboard(provider);

    return NextResponse.json({
      data,
      meta: { source: provider.source, generatedAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error("Dashboard API error", error);
    return NextResponse.json(
      { error: { code: "DASHBOARD_UNAVAILABLE", message: "The business overview is temporarily unavailable." } },
      { status: 502 },
    );
  }
}
