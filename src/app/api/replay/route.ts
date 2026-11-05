// GET /api/replay?from=&to= : the traces and gaps the Replay drum strip draws.
import type { NextRequest } from "next/server";
import { parseWindow, type Parsed, type Window } from "../../../api/server/params.ts";
import { buildReplay } from "../../../api/server/replay.ts";
import { json, RECENT_DATA, respond } from "../../../api/server/respond.ts";
import { getDb } from "../../../db/client.ts";
import { nowMs } from "../../../lib/clock.ts";

function parse(sp: URLSearchParams): Parsed<Window & { now: number }> {
  const now = nowMs();
  const w = parseWindow(sp, now);
  return w.ok ? { ok: true, value: { ...w.value, now } } : w;
}

export async function GET(req: NextRequest) {
  return respond(
    () => parse(req.nextUrl.searchParams),
    async (p) => json(await buildReplay(await getDb(), p), RECENT_DATA),
  );
}
