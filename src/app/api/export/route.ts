import { apiUser } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { exportAll } from "@/core/export";

export async function GET() {
  const user = await apiUser(); if (!user) return unauthorized();
  try {
    const data = await exportAll(user.id);
    return new Response(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="loic-os-export-${new Date().toISOString().slice(0, 10)}.json"` } });
  } catch (e) { return apiError(e); }
}
