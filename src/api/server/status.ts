// GET /api/status: per-layer source freshness from the fetch log.
//   live   the last OK fetch is within 2 times the source's cadence
//   stale  the last OK fetch is older, or there never was one
//   error  the most recent request failed and nothing succeeded since
// A request that failed before any response (a network error or timeout) only reaches
// fetch_errors, so the newest fetch_errors row counts as a failed request too.
import type { Db } from "../../db/client.ts";
import { sourceHealth } from "../../db/queries.ts";
import type { SourceState, StatusPayload } from "../types.ts";
import { LAYER_IDS, LAYER_SOURCES } from "./store.ts";

/** A source is live while its last OK fetch is at most this many cadences old. */
export const LIVE_CADENCES = 2;

export interface SourceHealth {
  lastOkAt: number | null;
  /** last_status of the newest fetch_log hour: the most recent logged request. */
  lastStatus: number | null;
  /** Newest fetch_errors row: HTTP errors, network errors, and unreadable bodies. */
  lastFailureAt: number | null;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** The state of one source. Pure. */
export function sourceState(h: SourceHealth, cadenceMs: number, now: number): SourceState {
  if (h.lastStatus !== null && !isOk(h.lastStatus)) return "error";
  if (h.lastFailureAt !== null && (h.lastOkAt === null || h.lastFailureAt >= h.lastOkAt)) {
    return "error";
  }
  if (h.lastOkAt !== null && now - h.lastOkAt <= LIVE_CADENCES * cadenceMs) return "live";
  return "stale";
}

/** Newest fetch_errors time per layer source (one index lookup each, one round trip). */
async function lastFailures(db: Db): Promise<Map<string, number>> {
  const sources = LAYER_IDS.map((l) => LAYER_SOURCES[l].source);
  const results = await db.batch(
    sources.map((source) => ({
      sql: "SELECT MAX(at) AS at FROM fetch_errors WHERE source = ?",
      args: [source],
    })),
    "read",
  );
  const out = new Map<string, number>();
  sources.forEach((source, i) => {
    const at = results[i]?.rows[0]?.at;
    if (at !== null && at !== undefined) out.set(source, Number(at));
  });
  return out;
}

export async function buildStatus(db: Db, p: { now: number }): Promise<StatusPayload> {
  const health = await sourceHealth(db);
  const failures = await lastFailures(db);
  const sources = {} as StatusPayload["sources"];
  for (const layer of LAYER_IDS) {
    const { source, cadenceMs } = LAYER_SOURCES[layer];
    const h: SourceHealth = {
      lastOkAt: health[source]?.lastOkAt ?? null,
      lastStatus: health[source]?.lastStatus ?? null,
      lastFailureAt: failures.get(source) ?? null,
    };
    sources[layer] = {
      state: sourceState(h, cadenceMs, p.now),
      lastOkAt: h.lastOkAt,
      lastStatus: h.lastStatus,
    };
  }
  return { now: p.now, sources };
}
