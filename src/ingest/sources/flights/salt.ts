// Pseudonymous aircraft ids (docs/plan.md section 2). A 32-byte random salt per UTC day, held in
// this closure only: never persisted, logged, exported, or returned. The previous day's salt is
// kept until 01:00 UTC so an aircraft already tracked before midnight keeps its id through an
// orbit in progress; after 01:00 it is zeroed and dropped, and the old ids cannot be recomputed.
import { getRandomValues } from "node:crypto";
import { keyedDigest } from "../../../lib/digest.ts";
import { MS_PER_DAY, MS_PER_HOUR } from "../../../lib/time.ts";

const SALT_BYTES = 32;
const ID_HEX_CHARS = 16;
/** How long after UTC midnight the previous day's salt stays usable. */
const GRACE_MS = MS_PER_HOUR;

export interface AircraftIdentity {
  /** Keyed digest of the ICAO address under the salt for time t (ms), first 16 hex chars. */
  aircraftId(icaoHex: string, t: number): string;
}

export interface AircraftIdentityOptions {
  /** Salt source; tests inject a fixed fake salt. Defaults to node:crypto getRandomValues. */
  randomBytes?: (size: number) => Uint8Array;
}

interface DaySalt {
  salt: Uint8Array;
  /** Ids handed out under this salt, so the grace hour can tell continuing aircraft apart. */
  issued: Set<string>;
}

const dayIndex = (t: number) => Math.floor(t / MS_PER_DAY);

export function createAircraftIdentity(opts: AircraftIdentityOptions = {}): AircraftIdentity {
  const random = opts.randomBytes ?? ((size: number) => getRandomValues(new Uint8Array(size)));
  const salts = new Map<number, DaySalt>();
  let latest = Number.NEGATIVE_INFINITY;

  const graceActive = () => latest - dayIndex(latest) * MS_PER_DAY < GRACE_MS;

  function drop(day: number) {
    const entry = salts.get(day);
    if (!entry) return;
    entry.salt.fill(0);
    entry.issued.clear();
    salts.delete(day);
  }

  function prune() {
    const today = dayIndex(latest);
    for (const day of [...salts.keys()]) {
      if (day < today - 1 || (day === today - 1 && !graceActive())) drop(day);
    }
  }

  function saltFor(day: number): DaySalt {
    let entry = salts.get(day);
    if (!entry) {
      const salt = Uint8Array.from(random(SALT_BYTES));
      if (salt.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`);
      entry = { salt, issued: new Set() };
      salts.set(day, entry);
    }
    return entry;
  }

  const digest = (entry: DaySalt, hex: string) =>
    keyedDigest(entry.salt, hex).slice(0, ID_HEX_CHARS);

  return {
    aircraftId(icaoHex, t) {
      if (!Number.isFinite(t)) throw new RangeError(`sample time must be finite, got ${t}`);
      const hex = icaoHex.trim().toLowerCase();
      if (!hex) throw new Error("empty ICAO address");
      if (t > latest) {
        latest = t;
        prune();
      }
      const today = dayIndex(latest);
      let day = dayIndex(t);
      // A late sample from a day whose salt is already gone takes today's salt.
      if (day < today - 1 || (day === today - 1 && !graceActive())) day = today;

      if (day === today && graceActive()) {
        const previous = salts.get(today - 1);
        if (previous) {
          const carried = digest(previous, hex);
          if (previous.issued.has(carried)) return carried;
        }
      }
      const entry = saltFor(day);
      const id = digest(entry, hex);
      entry.issued.add(id);
      return id;
    },
  };
}

// The process-wide identity used by the ingest worker. Its salts live and die with the process.
const shared = createAircraftIdentity();

/** Pseudonymous id for an ICAO address at time t, using the process-wide daily salt. */
export function aircraftId(icaoHex: string, t: number): string {
  return shared.aircraftId(icaoHex, t);
}
