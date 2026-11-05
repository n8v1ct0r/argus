// Each recorded layer's displayed span comes from the snapshot's replay summary, not a fixed
// "24 h": flights cover only their stored frames, the other layers the replay window.
import { expect, test } from "@playwright/test";
import type { ReplaySummary } from "../../src/api/types.ts";
import {
  crumbLabel,
  isPartial,
  layerSpans,
  recordedTitle,
  spanLabel,
} from "../../src/snapshot/windows.ts";

const at = (d: number, h: number, m: number, s = 0) => Date.UTC(2026, 10, d, h, m, s);

function summary(flightTimes: number[]): ReplaySummary {
  return {
    from: at(4, 16, 40, 43),
    to: at(5, 16, 40, 43),
    quakes: [],
    fires: [],
    flights: flightTimes.map((t) => ({ t, count: 1 })),
    events: [],
    gaps: [],
  };
}

test("flights span their first to last stored frame; the rest span the replay window", () => {
  const replay = summary([at(5, 15, 9, 43), at(5, 14, 59, 43), at(5, 16, 39, 43)]);
  const spans = layerSpans(replay);
  expect(spans.flights).toEqual({ from: at(5, 14, 59, 43), to: at(5, 16, 39, 43) });
  for (const id of ["quakes", "fires", "events", "satellites"] as const) {
    expect(spans[id]).toEqual({ from: replay.from, to: replay.to });
  }
  expect(isPartial(spans.flights, replay)).toBe(true);
  expect(isPartial(spans.quakes, replay)).toBe(false);

  expect(spanLabel(spans.flights!)).toBe("Nov 5 14:59 to 16:39 UTC");
  expect(spanLabel(spans.quakes!)).toBe("Nov 4 16:40 to Nov 5 16:40 UTC");
  expect(recordedTitle("flights", spans.flights)).toBe("Recorded Nov 5 14:59 to 16:39 UTC.");
  expect(recordedTitle("fires", spans.fires)).toBe("Recorded Nov 4 16:40 to Nov 5 16:40 UTC.");
});

test("a recording with no flight frames shows no flight span", () => {
  const spans = layerSpans(summary([]));
  expect(spans.flights).toBeNull();
  expect(recordedTitle("flights", spans.flights)).toBe("Recorded. No data in this recording.");
});

test("the breadcrumb names the recorded days", () => {
  expect(crumbLabel({ from: at(4, 16, 40), to: at(5, 16, 40) })).toBe("Recorded Nov 4 to 5");
  expect(crumbLabel({ from: at(5, 1, 0), to: at(5, 2, 0) })).toBe("Recorded Nov 5");
  expect(crumbLabel({ from: Date.UTC(2026, 9, 31, 12), to: at(1, 12, 0) })).toBe(
    "Recorded Oct 31 to Nov 1",
  );
  expect(crumbLabel(null)).toBe("Recorded");
});
