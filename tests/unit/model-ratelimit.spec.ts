import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { clientIpFrom, clientKey, normalizeIp, takeRateLimit } from "../../src/model/ratelimit.ts";
import { freshDb, MINUTE, T0 } from "../fixtures/model/events.ts";

const DAY = "2026-09-23";

test("Ask allows perTenMinutes per fixed 10-minute window, then says how long to wait", async () => {
  const db = await freshDb();
  const key = clientKey("203.0.113.7", DAY);
  const { perTenMinutes } = config.rateLimits.ask;
  const start = T0 + 2 * MINUTE; // 2 minutes into a window
  for (let i = 0; i < perTenMinutes; i++) {
    expect(await takeRateLimit(db, "ask", key, start + i * 1000)).toEqual({
      ok: true,
      retryAfterSeconds: 0,
    });
  }
  expect(await takeRateLimit(db, "ask", key, start + 60_000)).toEqual({
    ok: false,
    retryAfterSeconds: 7 * 60,
  });
  // A refused request is not counted, and another client is unaffected.
  const counts = await db.execute("SELECT route, count FROM rate_limits ORDER BY route");
  expect(counts.rows.map((r) => [String(r.route), Number(r.count)])).toEqual([
    ["ask:10m", perTenMinutes],
    ["ask:day", perTenMinutes],
  ]);
  expect((await takeRateLimit(db, "ask", clientKey("203.0.113.8", DAY), start)).ok).toBe(true);
  // The next window opens.
  expect((await takeRateLimit(db, "ask", key, T0 + 10 * MINUTE)).ok).toBe(true);
});

test("Ask allows perDay per UTC day across windows", async () => {
  const db = await freshDb();
  const key = clientKey("198.51.100.20", DAY);
  const { perTenMinutes, perDay } = config.rateLimits.ask;
  let taken = 0;
  let window = 0;
  while (taken < perDay) {
    for (let i = 0; i < perTenMinutes && taken < perDay; i++, taken++) {
      expect((await takeRateLimit(db, "ask", key, T0 + window * 10 * MINUTE + i)).ok).toBe(true);
    }
    window++;
  }
  const next = T0 + window * 10 * MINUTE;
  const refused = await takeRateLimit(db, "ask", key, next);
  expect(refused.ok).toBe(false);
  // Until the next UTC midnight.
  const midnight = Date.UTC(2026, 8, 24);
  expect(refused.retryAfterSeconds).toBe(Math.ceil((midnight - next) / 1000));
});

test("brief runs allow perHour per client per hour", async () => {
  const db = await freshDb();
  const key = clientKey("local", DAY);
  for (let i = 0; i < config.rateLimits.briefRun.perHour; i++) {
    expect((await takeRateLimit(db, "briefRun", key, T0 + i * MINUTE)).ok).toBe(true);
  }
  expect(await takeRateLimit(db, "briefRun", key, T0 + 30 * MINUTE)).toEqual({
    ok: false,
    retryAfterSeconds: 30 * 60,
  });
  expect((await takeRateLimit(db, "briefRun", key, T0 + 60 * MINUTE)).ok).toBe(true);
});

test("IPv6 clients are keyed per /64, IPv4 per address, and keys change every day", () => {
  expect(normalizeIp("2001:DB8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
  expect(normalizeIp("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
  expect(normalizeIp("[2001:db8:abcd:12::99]:443")).toBe("2001:db8:abcd:12::/64");
  expect(normalizeIp("fe80::1%en0")).toBe("fe80:0:0:0::/64");
  expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
  expect(normalizeIp("192.0.2.1:5555")).toBe("192.0.2.1");
  expect(normalizeIp(" 192.0.2.1 ")).toBe("192.0.2.1");
  expect(normalizeIp("")).toBe("local");

  const same = clientKey("2001:db8:abcd:12:aaaa::1", DAY);
  expect(clientKey("2001:db8:abcd:12:bbbb::2", DAY)).toBe(same);
  expect(clientKey("2001:db8:abcd:13::1", DAY)).not.toBe(same);
  expect(clientKey("192.0.2.1", DAY)).not.toBe(clientKey("192.0.2.2", DAY));
  expect(clientKey("::ffff:192.0.2.1", DAY)).toBe(clientKey("192.0.2.1", DAY));
  expect(clientKey("192.0.2.1", "2026-09-24")).not.toBe(clientKey("192.0.2.1", DAY));
  // The key is a digest: it never contains the address.
  expect(same).toMatch(/^[0-9a-f]{64}$/);
  expect(clientKey("192.0.2.1", DAY)).not.toContain("192.0.2.1");
});

test("x-forwarded-for is read only behind a trusted proxy, so a forged header gets no new bucket", () => {
  const forged = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
  // Untrusted (the default): every request shares the "local" bucket, whatever it claims.
  expect(clientIpFrom(forged, {})).toBe("local");
  expect(clientIpFrom(forged, { ARGUS_TRUST_PROXY: "true" })).toBe("local");
  // Trusted: the first value, which the edge sets.
  const trusted = { ARGUS_TRUST_PROXY: "1" };
  expect(clientIpFrom(forged, trusted)).toBe("203.0.113.5");
  expect(clientIpFrom(new Headers(), trusted)).toBe("local");
  expect(clientIpFrom(new Headers({ "x-forwarded-for": " " }), trusted)).toBe("local");
});

test("rate-limit rows store only the digest, never the address", async () => {
  const db = await freshDb();
  await takeRateLimit(db, "ask", clientKey("203.0.113.99", DAY), T0);
  const rows = await db.execute("SELECT * FROM rate_limits");
  expect(JSON.stringify(rows.rows)).not.toContain("203.0.113.99");
});
