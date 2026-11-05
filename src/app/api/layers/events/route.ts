// GET /api/layers/events?from=&to=&wildfires= : EONET natural events with a geometry in the
// window. Wildfires stay out unless wildfires=1, because FIRMS covers fires.
import type { NextRequest } from "next/server";
import { buildEventsLayer } from "../../../../api/server/natural-events.ts";
import {
  parseWildfires,
  parseWindow,
  type Parsed,
  type Window,
} from "../../../../api/server/params.ts";
import { json, RECENT_DATA, respond } from "../../../../api/server/respond.ts";
import { getDb } from "../../../../db/client.ts";
import { nowMs } from "../../../../lib/clock.ts";

function parse(sp: URLSearchParams): Parsed<Window & { wildfires: boolean }> {
  const w = parseWindow(sp, nowMs());
  if (!w.ok) return w;
  const wildfires = parseWildfires(sp);
  if (!wildfires.ok) return wildfires;
  return { ok: true, value: { ...w.value, wildfires: wildfires.value } };
}

export async function GET(req: NextRequest) {
  return respond(
    () => parse(req.nextUrl.searchParams),
    async (p) => json(await buildEventsLayer(await getDb(), p), RECENT_DATA),
  );
}
