// The static deploy's index file (public/snapshot/manifest.json), written by
// scripts/export-snapshot.ts.
export interface SnapshotManifest {
  version: 1;
  /** The replay window the app shows: 24 hours ending at the newest stored fetch. */
  windowFrom: number;
  windowTo: number;
  /** The first fetch of the recording. Flights exist only from here on. */
  recordedFrom: number;
  exportedAt: number;
  /** The model field of the brief: "demo-template" means code wrote it from templates. */
  briefModel: string;
  /** Request time (epoch ms, as a string) to a content-addressed payload file. */
  flights: Record<string, string>;
  fires: Record<string, string>;
}
