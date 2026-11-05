// GET /api/layers/fires?at= : fire cells from the 24 hours before `at`.
import type { NextRequest } from "next/server";
import { buildFiresLayer } from "../../../../api/server/fires.ts";
import { parseAt } from "../../../../api/server/params.ts";
import { FIRE_DATA, json, respond } from "../../../../api/server/respond.ts";
import { getDb } from "../../../../db/client.ts";
import { nowMs } from "../../../../lib/clock.ts";

export async function GET(req: NextRequest) {
  return respond(
    () => parseAt(req.nextUrl.searchParams, nowMs()),
    async (at) => json(await buildFiresLayer(await getDb(), { at }), FIRE_DATA),
  );
}
