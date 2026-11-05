// Per-client rate limits for the model routes (docs/plan.md section 7, "Model routes"). A client
// is a keyed digest of its network address and the UTC day, so the key changes every day and a
// raw IP is never stored or logged. IPv4 is keyed per address, IPv6 per /64.
import { getRandomValues } from "node:crypto";
import { isIP } from "node:net";
import { config } from "../../argus.config.ts";
import type { Db } from "../db/client.ts";
import { chargeWrites, type Writer } from "../db/queries.ts";
import { keyedDigest } from "../lib/digest.ts";
import { MS_PER_DAY, MS_PER_HOUR } from "../lib/time.ts";

export type LimitBucket = "ask" | "briefRun";

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the fullest window reopens; 0 when ok. */
  retryAfterSeconds: number;
}

interface LimitWindow {
  name: string;
  ms: number;
  limit: number;
}

const MS_PER_MINUTE = 60_000;
const TEN_MINUTES_MS = 10 * MS_PER_MINUTE;
const IPV6_GROUPS = 8;
const PREFIX_GROUPS = 4;
const MAX_UNPARSED_CHARS = 100;

/** The fixed windows each bucket counts in, from config.rateLimits. */
export function limitWindows(bucket: LimitBucket): LimitWindow[] {
  if (bucket === "ask") {
    return [
      { name: "10m", ms: TEN_MINUTES_MS, limit: config.rateLimits.ask.perTenMinutes },
      { name: "day", ms: MS_PER_DAY, limit: config.rateLimits.ask.perDay },
    ];
  }
  return [{ name: "hour", ms: MS_PER_HOUR, limit: config.rateLimits.briefRun.perHour }];
}

// Without ARGUS_HASH_SECRET, a random key for this process: client keys still cannot be turned
// back into addresses, and limits reset when the process restarts. Set the variable wherever more
// than one process serves the model routes, so they share limits.
const PROCESS_KEY = getRandomValues(new Uint8Array(32));

/** The HMAC key for client digests. An empty variable counts as unset. */
function hashSecret(): string | Uint8Array {
  return process.env.ARGUS_HASH_SECRET || PROCESS_KEY;
}

/** "2001:db8::1" to [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]; an embedded IPv4 tail fills 2 groups. */
function ipv6Groups(ip: string): number[] {
  let text = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const fill = new Array<number>(IPV6_GROUPS - left.length - right.length).fill(0);
  return [...left, ...(tail === undefined ? [] : fill), ...right];
}

/**
 * The part of an address a limit is keyed on: an IPv4 address as is (also when mapped into
 * IPv6), an IPv6 address as its /64 prefix, "local" when there is none. Anything unparseable is
 * kept as text (it is hashed, never stored).
 */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 0) ip = ip.slice(1, end);
  }
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (withPort?.[1]) ip = withPort[1];
  if (!ip || ip === "local") return "local";
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
    if (mapped) {
      const hi = g[6] ?? 0;
      const lo = g[7] ?? 0;
      return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
    }
    return `${g
      .slice(0, PREFIX_GROUPS)
      .map((x) => x.toString(16))
      .join(":")}::/64`;
  }
  return `unparsed:${ip.slice(0, MAX_UNPARSED_CHARS)}`;
}

/** The client's rate-limit key for a UTC day ("YYYY-MM-DD"). */
export function clientKey(ip: string, day: string): string {
  return keyedDigest(hashSecret(), `${normalizeIp(ip)}|${day}`);
}

/**
 * The client address a limit is keyed on. A forwarding header is only as honest as the proxy that
 * sets it, so x-forwarded-for is read only when ARGUS_TRUST_PROXY is "1": set it on a host whose
 * edge replaces that header. Otherwise every request is "local", one shared bucket, so a forged
 * header cannot mint fresh limits.
 */
export function clientIpFrom(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (env.ARGUS_TRUST_PROXY !== "1") return "local";
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/**
 * Counts one use against every window of the bucket, or refuses without counting when any window
 * is full. Two racing requests can each pass the read; the conditional increment then refuses the
 * one that would go over.
 */
export async function takeRateLimit(
  db: Db,
  bucket: LimitBucket,
  key: string,
  now: number,
): Promise<RateLimitResult> {
  const windows = limitWindows(bucket).map((w) => ({
    ...w,
    route: `${bucket}:${w.name}`,
    start: Math.floor(now / w.ms) * w.ms,
  }));
  const retryAfter = (w: { start: number; ms: number }) =>
    Math.max(1, Math.ceil((w.start + w.ms - now) / 1000));

  let wait = 0;
  for (const w of windows) {
    const rs = await db.execute({
      sql: "SELECT count FROM rate_limits WHERE client_key = ? AND route = ? AND window_start = ?",
      args: [key, w.route, w.start],
    });
    if (Number(rs.rows[0]?.count ?? 0) >= w.limit) wait = Math.max(wait, retryAfter(w));
  }
  if (wait > 0) return { ok: false, retryAfterSeconds: wait };

  const writer: Writer = bucket === "ask" ? "ask" : "system";
  await chargeWrites(db, windows.length, writer, now);
  for (const w of windows) {
    const rs = await db.execute({
      sql: `INSERT INTO rate_limits (client_key, route, window_start, count) VALUES (?, ?, ?, 1)
            ON CONFLICT(client_key, route, window_start) DO UPDATE SET count = count + 1
            WHERE rate_limits.count < ?`,
      args: [key, w.route, w.start, w.limit],
    });
    if (rs.rowsAffected === 0) return { ok: false, retryAfterSeconds: retryAfter(w) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}
