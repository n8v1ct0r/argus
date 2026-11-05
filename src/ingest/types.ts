import type { Source } from "../events/types.ts";

export type FetchImpl = typeof fetch;

/** What every source adapter's run function reports to the ingest worker. */
export interface SourceRunResult {
  source: Source;
  /** Upstream records seen in this run. */
  fetched: number;
  /** New event versions written. */
  inserted: number;
  status: "ok" | "not_modified" | "skipped_backoff" | "error";
  message?: string;
}

/** Dependencies a source adapter needs, injected so tests can pass a fake fetch and a fixed clock. */
export interface RunDeps {
  now: number;
  fetchImpl?: FetchImpl;
}
