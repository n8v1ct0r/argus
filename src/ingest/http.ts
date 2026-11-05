// One fetch path for every source: logs each request into the hourly fetch log and every
// failure into fetch_errors, so the UI can show live, stale, and error states per layer.
import type { Db } from "../db/client.ts";
import { logFetch, logFetchError } from "../db/queries.ts";
import type { FetchImpl } from "./types.ts";

export interface SourceFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  now: number;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/** Fetches a source URL and logs it. Never throws for HTTP errors; the caller reads res.status. */
export async function sourceFetch(
  db: Db,
  source: string,
  url: string,
  opts: SourceFetchOptions,
): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(url, {
      method: opts.method ?? "GET",
      headers: { "Accept-Encoding": "gzip", ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    // HEAD transfers no body; chunked responses report no length (logged as 0).
    const bytes = opts.method === "HEAD" ? 0 : Number(res.headers.get("content-length") ?? 0);
    await logFetch(db, source, res.status, bytes, opts.now);
    if (!res.ok)
      await logFetchError(db, source, redactUrl(url), res.status, `HTTP ${res.status}`, opts.now);
    return res;
  } catch (err) {
    await logFetchError(db, source, redactUrl(url), null, String(err), opts.now);
    throw err;
  }
}

/** Removes query values that could carry keys before a URL is logged. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/key|token|secret/i.test(k)) u.searchParams.set(k, "REDACTED");
    }
    return u.toString();
  } catch {
    return url;
  }
}
