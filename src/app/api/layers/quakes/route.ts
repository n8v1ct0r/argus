// GET /api/layers/quakes?from=&to= : earthquakes in the window, flagged when a cluster cites them.
import type { NextRequest } from "next/server";
import { parseWindow } from "../../../../api/server/params.ts";
import { buildQuakesLayer } from "../../../../api/server/quakes.ts";
import { json, RECENT_DATA, respond } from "../../../../api/server/respond.ts";
import { getDb } from "../../../../db/client.ts";
import { nowMs } from "../../../../lib/clock.ts";

export async function GET(req: NextRequest) {
  return respond(
    () => parseWindow(req.nextUrl.searchParams, nowMs()),
    async (w) => json(await buildQuakesLayer(await getDb(), w), RECENT_DATA),
  );
}
