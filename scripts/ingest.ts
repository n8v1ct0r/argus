// Starts the ingest worker (docs/plan.md section 7).
//
//   node scripts/ingest.ts --once   every source once, then the detectors and retention
//   node scripts/ingest.ts --loop   the long-running worker (Ctrl+C stops it cleanly)
//
// Reads .env.local when present (DATABASE_URL, ARGUS_APP_URL, ARGUS_SCHEDULER_SECRET, ARGUS_NOW).
// On SIGINT or SIGTERM the worker stops, running steps get a short grace period, and the ingest
// lease is released so the next worker can start at once. A second signal exits immediately.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { migrate, openDb } from "../src/db/client.ts";
import { releaseLease } from "../src/db/queries.ts";
import { createAdsbLolProvider } from "../src/ingest/sources/flights/adsblol.ts";
import { LEASE_NAME, runWorker, type WorkerSummary } from "../src/ingest/worker.ts";
import { nowMs } from "../src/lib/clock.ts";

const USAGE = "Usage: node scripts/ingest.ts --once | --loop";

function parseMode(args: string[]): "once" | "loop" | null {
  if (args.length !== 1) return null;
  if (args[0] === "--once") return "once";
  if (args[0] === "--loop") return "loop";
  return null;
}

function printSummary(summary: WorkerSummary): void {
  if (!summary.ran) {
    console.log("ingest summary: nothing ran (another worker holds the lease, or it was stopped)");
    return;
  }
  const sources = Object.entries(summary.totals);
  console.log(`ingest summary (${summary.mode}): ${sources.length} step kinds`);
  for (const [source, t] of sources) {
    console.log(
      `  ${source}: runs=${t.runs} errors=${t.errors} fetched=${t.fetched} inserted=${t.inserted}`,
    );
  }
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  if (!mode) {
    console.error(`${USAGE}\nPass exactly one of --once or --loop.`);
    return 2;
  }
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");

  const db = await openDb();
  await migrate(db);
  const holder = `ingest-${process.pid}-${randomUUID()}`;
  const controller = new AbortController();
  let signals = 0;
  const onSignal = (name: string) => {
    signals += 1;
    if (signals > 1) {
      console.error(`${name} again: exiting now. The lease expires on its own within 2 minutes.`);
      process.exit(130);
    }
    console.log(`${name}: stopping the worker and releasing the ingest lease`);
    controller.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    const summary = await runWorker({
      db,
      once: mode === "once",
      now: nowMs,
      flightsProvider: createAdsbLolProvider({ db }),
      signal: controller.signal,
      holder,
      // Each run line starts with its UTC time, so a long log can be read without the database.
      log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    });
    printSummary(summary);
    return 0;
  } finally {
    // runWorker releases the lease itself; this covers a worker that threw before it could.
    await releaseLease(db, LEASE_NAME, holder).catch(() => undefined);
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      `ingest failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Check DATABASE_URL and that the data directory is writable, then run it again.",
    );
    process.exit(1);
  },
);
