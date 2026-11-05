import { expect, test } from "@playwright/test";
import {
  MAX_WINDOW_MS,
  parseAt,
  parseIds,
  parseWildfires,
  parseWindow,
  splitIds,
} from "../../src/api/server/params.ts";
import { copyViolations } from "../../src/check/copy-rules.ts";

const NOW = 1_790_200_000_000;
const sp = (query: string) => new URLSearchParams(query);

test("ids split on commas; fire cell ids spell the cell with an underscore", () => {
  expect(splitIds("usgs:a@1,firms:cell:34_-119:20718@abc,firms:cell:-10_25:20718@def")).toEqual([
    "usgs:a@1",
    "firms:cell:34_-119:20718@abc",
    "firms:cell:-10_25:20718@def",
  ]);
  expect(splitIds("usgs:a@1,,usgs:b@2,")).toEqual(["usgs:a@1", "usgs:b@2"]);
  expect(splitIds("")).toEqual([]);

  const parsed = parseIds(sp("ids=usgs:a@1,usgs:a@1,eonet:EONET_1@x"));
  expect(parsed).toEqual({ ok: true, value: ["usgs:a@1", "eonet:EONET_1@x"] });
  // A piece that is not an event id fails the request.
  expect(parseIds(sp("ids=12345")).ok).toBe(false);
  expect(parseIds(sp("ids=usgs:a@1,12345")).ok).toBe(false);
});

test("windows default to the last 24 hours and may not run backwards or past 7 days", () => {
  expect(parseWindow(sp(""), NOW)).toEqual({
    ok: true,
    value: { from: NOW - 86_400_000, to: NOW },
  });
  expect(parseWindow(sp(`to=${NOW - 1000}`), NOW)).toEqual({
    ok: true,
    value: { from: NOW - 1000 - 86_400_000, to: NOW - 1000 },
  });
  expect(parseWindow(sp(`from=${NOW - MAX_WINDOW_MS}&to=${NOW}`), NOW).ok).toBe(true);
  expect(parseWindow(sp(`from=${NOW - MAX_WINDOW_MS - 1}&to=${NOW}`), NOW).ok).toBe(false);
  // Fractions are floored; exponents, signs, and words are refused.
  expect(parseWindow(sp(`from=${NOW - 10}.9&to=${NOW}`), NOW)).toEqual({
    ok: true,
    value: { from: NOW - 10, to: NOW },
  });
  for (const q of ["from=1e12", "to=-1", "from=%20", "to=99999999999999999", "from=0x10"]) {
    expect(parseWindow(sp(q), NOW).ok, q).toBe(false);
  }
  expect(parseAt(sp(""), NOW)).toEqual({ ok: true, value: NOW });
  expect(parseAt(sp("at=5"), NOW)).toEqual({ ok: true, value: 5 });
  expect(parseWildfires(sp("wildfires=0"))).toEqual({ ok: true, value: false });
  expect(parseWildfires(sp("wildfires=1"))).toEqual({ ok: true, value: true });
  expect(parseWildfires(sp("wildfires=true")).ok).toBe(false);
});

test("every input error follows the copy rules and says what to do", () => {
  const errors = [
    parseWindow(sp("from=x"), NOW),
    parseWindow(sp(`from=${NOW}&to=${NOW}`), NOW),
    parseWindow(sp(`from=0&to=${NOW}`), NOW),
    parseAt(sp("at=x"), NOW),
    parseWildfires(sp("wildfires=x")),
    parseIds(sp("")),
    parseIds(sp(`ids=${Array.from({ length: 51 }, (_, i) => `usgs:${i}`).join(",")}`)),
    parseIds(sp(`ids=${encodeURIComponent("Nope")}`)),
  ].map((r) => (r.ok ? "" : r.error));
  for (const error of errors) {
    expect(error).toMatch(/^[A-Z][^–—]*[.]$/);
    expect(copyViolations(error)).toEqual([]);
  }
});
