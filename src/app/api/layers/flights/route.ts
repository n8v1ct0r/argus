// GET /api/layers/flights?at= : aircraft from the newest frame of each flight area in the
// 30 minutes up to `at`. No aircraft identifier of any kind is in the payload.
import type { NextRequest } from "next/server";
import { buildFlightsLayer } from "../../../../api/server/flights.ts";
import { parseAt } from "../../../../api/server/params.ts";
import { json, RECENT_DATA, respond } from "../../../../api/server/respond.ts";
import { getDb } from "../../../../db/client.ts";
import { nowMs } from "../../../../lib/clock.ts";

export async function GET(req: NextRequest) {
  return respond(
    () => parseAt(req.nextUrl.searchParams, nowMs()),
    async (at) => json(await buildFlightsLayer(await getDb(), { at }), RECENT_DATA),
  );
}
