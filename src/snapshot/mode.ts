// Which data the app reads. "snapshot" is the static deploy: recorded JSON from
// public/snapshot plus the live USGS feed fetched in the browser. Anything else reads the API
// routes backed by the local store. Set at build time by next.config.ts.
export const SNAPSHOT_MODE = process.env.NEXT_PUBLIC_ARGUS_MODE === "snapshot";
