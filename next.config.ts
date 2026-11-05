import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The globe package ships TypeScript source; Next compiles it.
  transpilePackages: ["@argus/globe"],
  // libSQL loads a native binding on the server; keep it out of the bundle.
  // satellite.js runs SGP4 on the server only: Turbopack hangs when it bundles the package
  // (its WASM module) for the browser, so the client never imports it.
  serverExternalPackages: ["@libsql/client", "libsql", "satellite.js"],
  // Vercel cannot run the ingest worker or keep a libSQL file, so a Vercel build (VERCEL=1) is
  // the static deploy: recorded JSON in public/snapshot plus the live USGS feed. ARGUS_MODE
  // overrides it either way ("snapshot" or "store").
  env: {
    NEXT_PUBLIC_ARGUS_MODE: process.env.ARGUS_MODE ?? (process.env.VERCEL ? "snapshot" : "store"),
  },
};

export default nextConfig;
