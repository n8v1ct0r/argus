// GET /api/layers/satellites?from=&to=&step= : SGP4 positions on a time grid for the replay
// window. The client interpolates between grid points along the arc.
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "../../../../db/client.ts";
import { listEvents } from "../../../../db/queries.ts";
import { nowMs } from "../../../../lib/clock.ts";
import { propagateGrid, type ElementSet } from "../../../../satellites/propagate.ts";

const DEFAULT_STEP_S = 300;
const MAX_POINTS = 400;
const WINDOW_MS = 24 * 3_600_000;

export async function GET(req: NextRequest) {
  const now = nowMs();
  const sp = req.nextUrl.searchParams;
  const to = Number(sp.get("to") ?? now);
  const from = Number(sp.get("from") ?? to - WINDOW_MS);
  const step = Math.max(60, Number(sp.get("step") ?? DEFAULT_STEP_S)) * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return NextResponse.json(
      { error: "from and to must be epoch milliseconds with from before to" },
      { status: 400 },
    );
  }
  const times: number[] = [];
  for (let t = from; t <= to && times.length < MAX_POINTS; t += step) times.push(t);

  const db = await getDb();
  // Newest element set per satellite (element sets change 2 to 3 times a day upstream).
  const rows = await listEvents(db, { kinds: ["satellite_elements"], limit: 5000, order: "desc" });
  const newest = new Map<string, ElementSet>();
  for (const e of rows) {
    if (newest.has(e.recordKey) || !e.raw) continue;
    newest.set(e.recordKey, {
      id: e.id,
      name: e.facts.name?.text ?? e.recordKey,
      omm: JSON.parse(e.raw),
    });
  }
  const grid = propagateGrid([...newest.values()], times);
  return NextResponse.json(grid, {
    headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
  });
}
