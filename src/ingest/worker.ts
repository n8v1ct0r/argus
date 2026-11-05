// The ingest worker (docs/plan.md section 7): one long-running process that polls every source
// on its own cadence from argus.config.ts, runs each detector after its inputs change, asks the
// Next server for the hourly brief, and applies retention. A database lease keeps it
// single-flight: a second worker exits quietly.
//
// Loop mode runs four lanes at once, each one step at a time:
//   sources  USGS (then quake clusters), EONET, CelesTrak, FIRMS (then presence and fire growth),
//            the one-time fire presence bootstrap, and hourly retention;
//   flights  a detector sample every flightsDetectorSeconds, one layer area right after a sample
//            while a layer poll is due, and a detector batch (then circling) every
//            flightsDetectorBatchSeconds. One lane, so two flights requests never overlap; slotting
//            layer areas between samples keeps the detector's 30 s grid (the provider's queue
//            spaces requests flightsMinSpacingSeconds apart);
//   brief    POST /api/brief/run at every briefMinutes boundary of the clock;
//   lease    renews the lease every 30 s and stops the worker if another holder took it.
// A long FIRMS download never delays a flights sample, and a slow brief never delays ingest.
// Every step logs one line; an error is logged and the lane moves on (adapters keep their own
// persisted backoff).
import { randomUUID } from "node:crypto";
import { config } from "../../argus.config.ts";
import type { Db } from "../db/client.ts";
import { acquireLease, insertEvents, releaseLease } from "../db/queries.ts";
import type { FlightSample } from "../detectors/types.ts";
import { MS_PER_HOUR } from "../lib/time.ts";
import {
  runCirclingDetector,
  runFireGrowthDetector,
  runQuakeClusterDetector,
  trimCirclingBuffer,
  type DetectorRun,
} from "./detections.ts";
import { applyRetention, type RetentionSummary } from "./retention.ts";
import { runCelestrak } from "./sources/celestrak.ts";
import { runEonet } from "./sources/eonet.ts";
import {
  bootstrapPresence,
  presenceDayCount,
  recomputePresence,
  runFirms,
} from "./sources/firms.ts";
import type { FlightArea, FlightProvider } from "./sources/flights/adapter.ts";
import { createAdsbLolProvider } from "./sources/flights/adsblol.ts";
import { buildDetectorBatch, buildLayerFrame } from "./sources/flights/frames.ts";
import { redactAll } from "./sources/flights/redact.ts";
import { fetchLogRef, runFlightsDetectorSample } from "./sources/flights/run.ts";
import { aircraftId } from "./sources/flights/salt.ts";
import { runUsgs } from "./sources/usgs.ts";
import type { FetchImpl, RunDeps, SourceRunResult } from "./types.ts";

export const LEASE_NAME = "ingest";
export const LEASE_TTL_MS = 120_000;
export const LEASE_RENEW_MS = 30_000;
export const RETENTION_EVERY_MS = MS_PER_HOUR;
/** After a stop, how long running steps get to finish before the lease is released anyway. */
export const SHUTDOWN_GRACE_MS = 15_000;
export const DEFAULT_APP_URL = "http://localhost:3000";
/** A brief makes up to 2 model calls; give the route time to answer. */
const BRIEF_TIMEOUT_MS = 180_000;
const MAX_MESSAGE_CHARS = 300;

const SECOND_MS = 1000;
const cadence = config.cadence;
const DETECTOR_AREA = config.sources.flights.detectorArea;
/**
 * Aircraft seen this recently stay in the circling detector's buffer: its window plus one batch
 * interval, so every window of windowMinutes ends inside some batch's buffer and a turn that
 * straddles two batches is seen. trimCirclingBuffer keeps each such aircraft's continuous track.
 */
const SAMPLE_BUFFER_MS =
  config.detectors.circling.windowMinutes * 60 * SECOND_MS +
  cadence.flightsDetectorBatchSeconds * SECOND_MS;

export interface WorkerOptions {
  db: Db;
  /** Run every source once, then the detectors and retention, and return. */
  once: boolean;
  now: () => number;
  fetchImpl?: FetchImpl;
  /** Defaults to the adsb.lol provider (its own serial queue spaces requests). */
  flightsProvider?: FlightProvider;
  /** Stops the loop; running steps finish (up to SHUTDOWN_GRACE_MS) and the lease is released. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Loop mode: asks for a brief covering the window that ends at windowEnd. */
  briefTrigger?: (windowEnd: number) => Promise<void>;
  /** Lease holder name; defaults to a random one per run. */
  holder?: string;
  /** Resolves after ms or as soon as the signal aborts. Tests pass a fake clock's sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Loop mode: when fire_presence holds fewer than persistenceMinDays days, download the FIRMS
   * 7-day files once (about 43 MB each). Defaults to true; never in once mode.
   */
  bootstrapFirePresence?: boolean;
}

/** One logged step. */
export interface RunLine {
  source: string;
  status: string;
  fetched: number;
  inserted: number;
  ms: number;
  message?: string;
}

export interface RunTotals {
  runs: number;
  errors: number;
  fetched: number;
  inserted: number;
}

export interface WorkerSummary {
  mode: "once" | "loop";
  /** False when another worker held the lease, or the signal had already aborted; nothing ran. */
  ran: boolean;
  /** Once mode: every line in order. Loop mode: the latest line per source. */
  runs: RunLine[];
  totals: Record<string, RunTotals>;
  retention: RetentionSummary | null;
}

type Outcome = Omit<RunLine, "source" | "ms">;

/** Thrown by a brief trigger when the brief could not be asked for (logged as skipped). */
export class BriefSkipped extends Error {
  override name = "BriefSkipped";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatRunLine(line: RunLine): string {
  const head = `${line.source} ${line.status} fetched=${line.fetched} inserted=${line.inserted} ms=${line.ms}`;
  if (!line.message) return head;
  const message = line.message.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
  return `${head} ${message}`;
}

/**
 * The default brief trigger: POST {windowEnd} to /api/brief/run on the Next server
 * (ARGUS_APP_URL, default http://localhost:3000) with the shared scheduler secret. Throws
 * BriefSkipped when the secret is unset or the server does not answer, so the worker logs one
 * line and carries on. The secret is sent only in the header and never logged.
 */
export function createBriefTrigger(
  opts: { fetchImpl?: FetchImpl; env?: Record<string, string | undefined> } = {},
): (windowEnd: number) => Promise<void> {
  return async (windowEnd) => {
    const env = opts.env ?? process.env;
    const secret = env.ARGUS_SCHEDULER_SECRET;
    const base = (env.ARGUS_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
    if (!secret) {
      throw new BriefSkipped(
        "ARGUS_SCHEDULER_SECRET is not set. Add it to .env.local to run the hourly brief.",
      );
    }
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(`${base}/api/brief/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-argus-scheduler": secret },
        body: JSON.stringify({ windowEnd }),
        signal: AbortSignal.timeout(BRIEF_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BriefSkipped(
        `The app server at ${base} did not answer (${errorText(err)}). Start it with pnpm dev or pnpm start.`,
      );
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let reason = "";
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === "string") reason = `: ${body.error}`;
      } catch {
        // not JSON; the status says enough
      }
      throw new Error(`/api/brief/run answered HTTP ${res.status}${reason}`);
    }
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The next run time on a fixed grid; a run that fell a whole period behind starts a new grid. */
function advance(scheduledAt: number, everyMs: number, now: number): number {
  const next = scheduledAt + everyMs;
  return next > now ? next : now + everyMs;
}

function fromSource(r: SourceRunResult): Outcome {
  return {
    status: r.status,
    fetched: r.fetched,
    inserted: r.inserted,
    ...(r.message ? { message: r.message } : {}),
  };
}

function fromDetector(r: DetectorRun): Outcome {
  return {
    status: "ok",
    fetched: r.examined,
    inserted: r.stored,
    ...(r.note ? { message: r.note } : {}),
  };
}

function retentionMessage(r: RetentionSummary): string {
  return (
    `deleted ${r.events} events (kept ${r.keptOld} old ones a rule protects), ${r.briefs} briefs, ` +
    `${r.firePresence} fire presence days, ${r.modelCache} cache rows, ${r.rateLimits} rate limit rows, ` +
    `${r.fetchLog} fetch log rows, ${r.fetchErrors} fetch errors, ${r.links} links`
  );
}

export async function runWorker(opts: WorkerOptions): Promise<WorkerSummary> {
  const { db, once } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const holder = opts.holder ?? `ingest-${process.pid}-${randomUUID()}`;
  const sleepImpl = opts.sleep ?? defaultSleep;
  const provider = opts.flightsProvider ?? createAdsbLolProvider({ db, fetchImpl: opts.fetchImpl });
  const briefTrigger = opts.briefTrigger ?? createBriefTrigger({ fetchImpl: opts.fetchImpl });

  const summary: WorkerSummary = {
    mode: once ? "once" : "loop",
    ran: false,
    runs: [],
    totals: {},
    retention: null,
  };
  const latest = new Map<string, RunLine>();

  const stopper = new AbortController();
  const stop = () => stopper.abort();
  const stopped = () => stopper.signal.aborted;
  if (opts.signal?.aborted) return summary;
  opts.signal?.addEventListener("abort", stop, { once: true });
  const sleep = (ms: number) => sleepImpl(Math.max(0, ms), stopper.signal);
  const deps = (): RunDeps => ({
    now: opts.now(),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  function record(line: RunLine): void {
    log(formatRunLine(line));
    const t = (summary.totals[line.source] ??= { runs: 0, errors: 0, fetched: 0, inserted: 0 });
    t.runs += 1;
    t.fetched += line.fetched;
    t.inserted += line.inserted;
    if (line.status === "error") t.errors += 1;
    if (once) summary.runs.push(line);
    else latest.set(line.source, line);
  }

  async function step(source: string, fn: () => Promise<Outcome>): Promise<Outcome> {
    const started = performance.now();
    let out: Outcome;
    try {
      out = await fn();
    } catch (err) {
      out = { status: "error", fetched: 0, inserted: 0, message: errorText(err) };
    }
    record({ source, ...out, ms: Math.round(performance.now() - started) });
    return out;
  }

  // Steps -------------------------------------------------------------------------------------

  const usgs = () => step("usgs", async () => fromSource(await runUsgs(db, deps())));
  const eonet = () => step("eonet", async () => fromSource(await runEonet(db, deps())));
  const celestrak = () => step("celestrak", async () => fromSource(await runCelestrak(db, deps())));
  const quakeClusters = () =>
    step("quake-cluster", async () => fromDetector(await runQuakeClusterDetector(db, opts.now())));

  /** FIRMS, then presence (unless the run already rebuilt it), then fire growth. */
  let firmsRebuiltPresence = false;
  const firms = () =>
    step("firms", async () => {
      const r = await runFirms(db, deps());
      firmsRebuiltPresence = r.status === "ok" && r.inserted > 0;
      return fromSource(r);
    });
  const fireGrowth = () =>
    step("fire-growth", async () => {
      const now = opts.now();
      if (!firmsRebuiltPresence) await recomputePresence(db, now);
      return fromDetector(await runFireGrowthDetector(db, now));
    });
  const fireBootstrap = () =>
    step("fire-bootstrap", async () => {
      const have = await presenceDayCount(db);
      if (have >= config.detectors.fireGrowth.persistenceMinDays) {
        return { status: "not_modified", fetched: 0, inserted: 0, message: `${have} days stored` };
      }
      return fromSource(await bootstrapPresence(db, deps()));
    });
  const retention = () =>
    step("retention", async () => {
      const r = await applyRetention(db, opts.now());
      summary.retention = r;
      return {
        status: "ok",
        fetched: r.events + r.keptOld,
        inserted: 0,
        message: retentionMessage(r),
      };
    });

  // Flights: one layer area per call, then the detector samples and batches.
  const flights = {
    /** Continuous tracks of aircraft seen within SAMPLE_BUFFER_MS, for the circling detector. */
    buffer: [] as FlightSample[],
    /** Samples since the last stored detector batch. */
    pending: [] as FlightSample[],
    /** Start of the current batch window (the last batch's end, or the first sample). */
    windowStart: null as number | null,
  };

  const layerArea = (area: FlightArea) =>
    step("flights-layer", async () => {
      const res = await provider.fetchArea(area, opts.now());
      if (!res.ok) {
        return {
          status: res.skipped ? "skipped_backoff" : "error",
          fetched: 0,
          inserted: 0,
          message: `${area.id}: ${res.message}`,
        };
      }
      const samples = redactAll(res.aircraft, res.now, aircraftId);
      const requestedAt = res.requestedAt ?? res.now;
      const frame = buildLayerFrame(area.id, samples, res.now, fetchLogRef(requestedAt));
      const inserted = await insertEvents(db, [frame], "ingest", requestedAt);
      return { status: "ok", fetched: res.aircraft.length, inserted, message: area.id };
    });

  const detectorSample = () =>
    step("flights-sample", async () => {
      const now = opts.now();
      const r = await runFlightsDetectorSample(db, { ...deps(), now, provider });
      if (r.status === "ok") {
        flights.windowStart ??= now;
        flights.pending.push(...r.samples);
        flights.buffer.push(...r.samples);
      }
      flights.buffer = trimCirclingBuffer(flights.buffer, now, SAMPLE_BUFFER_MS);
      if (r.status !== "ok") return fromSource(r);
      return { ...fromSource(r), message: `${r.samples.length} samples kept after redaction` };
    });

  const detectorBatch = async () => {
    const now = opts.now();
    await step("flights-batch", async () => {
      const samples = flights.pending;
      const windowStart = flights.windowStart ?? now;
      flights.pending = [];
      flights.windowStart = now;
      if (!samples.length) {
        return { status: "ok", fetched: 0, inserted: 0, message: "no samples in this window" };
      }
      const frame = buildDetectorBatch(DETECTOR_AREA.id, samples, windowStart, now, now);
      const inserted = await insertEvents(db, [frame], "ingest", now);
      return { status: "ok", fetched: samples.length, inserted };
    });
    await step("circling", async () =>
      fromDetector(await runCirclingDetector(db, flights.buffer, now)),
    );
  };

  const brief = (windowEnd: number) =>
    step("brief", async () => {
      try {
        await briefTrigger(windowEnd);
      } catch (err) {
        if (err instanceof BriefSkipped) {
          return { status: "skipped", fetched: 0, inserted: 0, message: err.message };
        }
        throw err;
      }
      const label = new Date(windowEnd).toISOString();
      return { status: "ok", fetched: 0, inserted: 0, message: `window end ${label}` };
    });

  // Lease -------------------------------------------------------------------------------------

  const renew = () => acquireLease(db, LEASE_NAME, holder, LEASE_TTL_MS, opts.now());

  if (!(await renew())) {
    log(`ingest lease is held by another worker; exiting`);
    return summary;
  }
  summary.ran = true;

  try {
    if (once) {
      const steps: Array<() => Promise<unknown>> = [
        usgs,
        eonet,
        celestrak,
        firms,
        async () => {
          for (const area of config.sources.flights.layerAreas) {
            if (stopped()) return;
            // After a failure the provider's backoff blocks the other areas anyway.
            if ((await layerArea(area)).status !== "ok") return;
          }
        },
        detectorSample,
        quakeClusters,
        fireGrowth,
        detectorBatch,
        retention,
      ];
      for (const run of steps) {
        if (stopped()) break;
        if (!(await renew())) {
          log("ingest lease was taken by another worker; stopping");
          break;
        }
        await run();
      }
    } else {
      await runLoop();
    }
  } finally {
    stop();
    opts.signal?.removeEventListener("abort", stop);
    await releaseLease(db, LEASE_NAME, holder).catch((err: unknown) =>
      log(`ingest lease release failed: ${errorText(err)}`),
    );
    if (!once) summary.runs = [...latest.values()];
  }
  return summary;

  // Loop mode ---------------------------------------------------------------------------------

  async function runLoop(): Promise<void> {
    const start = opts.now();
    const bootstrap = opts.bootstrapFirePresence ?? true;

    interface Job {
      everyMs: number;
      nextAt: number;
      run: () => Promise<unknown>;
    }
    const job = (everyMs: number, run: () => Promise<unknown>, nextAt = start): Job => ({
      everyMs,
      nextAt,
      run,
    });
    const sourceJobs: Job[] = [
      job(cadence.usgsSeconds * SECOND_MS, async () => {
        await usgs();
        await quakeClusters();
      }),
      job(cadence.eonetSeconds * SECOND_MS, eonet),
      job(cadence.celestrakSeconds * SECOND_MS, celestrak),
      job(cadence.firmsHeadSeconds * SECOND_MS, async () => {
        await firms();
        await fireGrowth();
      }),
      ...(bootstrap ? [job(Infinity, fireBootstrap)] : []),
      job(RETENTION_EVERY_MS, retention),
    ];

    async function sourcesLane(): Promise<void> {
      while (!stopped()) {
        const now = opts.now();
        // Earlier jobs win when several are due; the list is in plan order.
        const due = sourceJobs.find((j) => j.nextAt <= now);
        if (due) {
          due.nextAt = advance(due.nextAt, due.everyMs, now);
          await due.run();
          continue;
        }
        await sleep(Math.min(...sourceJobs.map((j) => j.nextAt)) - now);
      }
    }

    async function flightsLane(): Promise<void> {
      const sampleMs = cadence.flightsDetectorSeconds * SECOND_MS;
      const layerMs = cadence.flightsLayerSeconds * SECOND_MS;
      const batchMs = cadence.flightsDetectorBatchSeconds * SECOND_MS;
      let nextSample = start;
      let nextLayer = start;
      let nextBatch = start + batchMs;
      let areas: FlightArea[] = [];
      while (!stopped()) {
        const now = opts.now();
        if (now < nextSample) {
          await sleep(nextSample - now);
          continue;
        }
        nextSample = advance(nextSample, sampleMs, now);
        await detectorSample();
        if (now >= nextLayer) {
          nextLayer = advance(nextLayer, layerMs, now);
          areas = [...config.sources.flights.layerAreas];
        }
        const area = areas.shift();
        if (area && !stopped() && (await layerArea(area)).status !== "ok") areas = [];
        if (now >= nextBatch && !stopped()) {
          nextBatch = advance(nextBatch, batchMs, now);
          await detectorBatch();
        }
      }
    }

    async function briefLane(): Promise<void> {
      const everyMs = cadence.briefMinutes * 60 * SECOND_MS;
      const boundaryAfter = (t: number) => (Math.floor(t / everyMs) + 1) * everyMs;
      let next = boundaryAfter(start);
      while (!stopped()) {
        const now = opts.now();
        if (now < next) {
          await sleep(next - now);
          continue;
        }
        const windowEnd = next;
        next = boundaryAfter(now);
        await brief(windowEnd);
      }
    }

    async function leaseLane(): Promise<void> {
      while (!stopped()) {
        await sleep(LEASE_RENEW_MS);
        if (stopped()) return;
        let held = false;
        try {
          held = await renew();
        } catch (err) {
          log(`ingest lease renewal failed: ${errorText(err)}`);
          continue;
        }
        if (!held) {
          log("ingest lease was taken by another worker; stopping");
          stop();
        }
      }
    }

    /** A lane that throws is a bug; log it and stop the worker rather than run half of it. */
    const guard = (name: string, lane: () => Promise<void>) =>
      lane().catch((err: unknown) => {
        log(`${name} lane stopped on an unexpected error: ${errorText(err)}`);
        stop();
      });
    const lanes = Promise.all([
      guard("sources", sourcesLane),
      guard("flights", flightsLane),
      guard("brief", briefLane),
      guard("lease", leaseLane),
    ]);

    await new Promise<void>((resolve) => {
      if (stopped()) resolve();
      else stopper.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log(`running steps did not finish within ${SHUTDOWN_GRACE_MS} ms of the stop`);
        resolve();
      }, SHUTDOWN_GRACE_MS);
      timer.unref?.();
    });
    await Promise.race([lanes, grace]);
    clearTimeout(timer);
  }
}
