// GET /api/status : per-layer source freshness (live, stale, error). Never cached.
import { json, NO_STORE, respond } from "../../../api/server/respond.ts";
import { buildStatus } from "../../../api/server/status.ts";
import { getDb } from "../../../db/client.ts";
import { nowMs } from "../../../lib/clock.ts";

export async function GET() {
  return respond(
    () => ({ ok: true, value: nowMs() }),
    async (now) => json(await buildStatus(await getDb(), { now }), NO_STORE),
  );
}
