// GET /api/brief : the newest published brief from the retention window. No model call.
import type { BriefPayload } from "../../../api/types.ts";
import { latestBriefPayload } from "../../../brief/generate.ts";
import { getDb } from "../../../db/client.ts";
import { nowMs } from "../../../lib/clock.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload: BriefPayload = await latestBriefPayload(await getDb(), nowMs());
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("GET /api/brief failed:", err instanceof Error ? err.message : err);
    return Response.json(
      { error: "The brief store could not be read. Try again in a minute." },
      { status: 500 },
    );
  }
}
