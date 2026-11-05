# Argus: task state

Objective: build, polish, capture, and publish Argus per `.local/brief.md`. Stop at the end of each phase for Nate's approval.

## Current phase

Ship (2026-11-05) on branch `ship` (from `remove-harness`, which holds all Phase 2 work plus CI): a static deploy for the portfolio. Phase 2 items below that need a server, a key, or a long run stay open.

## Redesign: dark glass console (2026-11-05, branch ship)

- [x] Layout from Nate's reference (structure only): top bar (breadcrumb, replay clock, measured latency, Ask search, Alerts pill), left rail (nav, layer checkboxes with LIVE or RECORDED badges, quake magnitude trace), globe as hero, bottom row (event inspector, counts at the replay time, brief feed with kind chips and a quakes per hour sparkline), replay record
- [x] Globe surface "dots" in @argus/globe: grayscale imagery seen through a screen-space dot grid (globe material), gray atmosphere; `onCameraChange` for the HUD (latitude ladder, longitude tape, focus frame)
- [x] Wow path kept: a sentence flies and pings its events and opens the Citations sheet over the globe; on phones the page scrolls to the globe
- [x] 390 and 360 px: scrollWidth equals clientWidth; honesty strip text not clipped (e2e covers both)
- [x] Perf: platform fonts (2 web fonts dropped), Cesium after load idle on desktop and on request on phones, a 11,656 byte still of Earth first (`scripts/capture-globe-still.ts`), flights and fires after idle, no double layout (CLS 0 mobile)
- [x] Lighthouse (local `pnpm start`, snapshot build, 3 runs each): before mobile 37/48/61, desktop 75/93/94; after mobile 94/93/93, desktop 97/97/97
- Contradiction logged: PRODUCT.md says "no single decorative accent"; Nate's 2026-11-05 direction asks for one accent color. The UI now uses one orange accent for selection, citations, findings, and alerts. PRODUCT.md not edited.
- Note: phones do not download Cesium until the visitor taps "Load the 3D globe" or opens a sentence; that is part of the mobile score.

## Ship (2026-11-05)

- [x] Snapshot mode (`NEXT_PUBLIC_ARGUS_MODE=snapshot`, set by `next.config.ts` on Vercel): the app reads `public/snapshot` instead of the API routes
- [x] `scripts/export-snapshot.ts`: every API payload for a recorded window; flights and fires content-addressed
- [x] DEMO template brief and preset Ask answers (`src/brief/template.ts`), checked by rule 4 at export; a quake count from `count_events` leads
- [x] Live USGS past day feed fetched in the browser, recorded USGS ids left out, green rings
- [x] Shared honesty strip (`[data-honesty-strip]`), RECORDED and LIVE tags per source, DEMO label on the brief and Ask
- [x] Wow path: a sentence flies to its events and pings them; spread citations get a tour
- [x] Fixed: Cesium credits overlapped the replay strip; the phone globe had 0 height
- [x] Stealth scan decision 7 applied (bounded match for terms of 3 characters or fewer); `pnpm-lock.yaml` tracked
- [x] /spike route removed
- [x] Final recording: 2026-11-05 14:59 to 16:40 UTC (`data/ship/capture.db`, not tracked); export: 5 bullets, 22 numbers checked, 0 violations; `check-briefs` 0 violations; 4 preset answers; 11 flight frames, 25 fire hours, 193 citable records
- [x] Vercel project `argus` linked; preview deploys READY and serve every snapshot file (preview URLs sit behind Vercel login)
- [ ] Production deploy: a local branch-guard hook blocks the production deploy flag from this session (it reads the branch of the session's start directory, not this repo). Run it from this repo.
- [ ] Public repo: the snapshot at /private/tmp/claude-501/ship-snapshots/argus (1 commit, noreply author) passed the secret scan and the stealth scan, but the session's permission classifier denied creating a public repo. Needs Nate.

## Phase 1: plan (done, approved 2026-09-23)

- [x] Plan (docs/plan.md), PRODUCT.md, research (16 agents), adversarial critique (65 findings fixed)
- [x] Decisions: adsb.lol, the drum record, all approvals (deps, keyless FIRMS, no ion, UA contact github.com/n8v1ct0r, key in .env.local, $5.00 Phase 2 model cap)

## Phase 2: MVP

- [x] Scaffold: pnpm workspace, Next 16.3.6, TypeScript 6.0.3, ESLint boundary rules, Prettier, Playwright (unit + e2e projects)
- [x] Spike gate: Cesium under Turbopack, keyless GIBS day + self-hosted Black Marble night, 57.8 fps mean / 56.5 fps p5 with planned primitive counts, 0 console issues, 0 ion or Bing requests
- [x] Foundation: config, event contract, libSQL store, write guard, lease, backoff, fetch log
- [x] Modules (7 parallel worktree agents, merged): USGS, CelesTrak, EONET, FIRMS, adsb.lol flights with redaction, detectors, rule-4 checker
- [x] UI shell: drum-record layout, Replay strip slider, Sources rail, Brief rail with citations and Ask, credits line, phone layout, /about
- [x] Server-side SGP4 satellites route
- [x] Stage 2 (3 parallel agents, merged 2026-09-24): ingest worker + retention + CLI; read API routes; model layer + brief + Ask + check-briefs
- [x] Post-merge: fire growth via fireGrowthDue, one circling pseudonym, fire cell ids without commas, aggregate members, rate-limit security fixes
- [x] EXPLAIN QUERY PLAN check (pnpm check:indexes): 0 full scans in 79 product statements
- [x] Tooling: stealth-scan.sh, check-copy.ts, check-build.ts (postbuild), measure-fps.ts, DATA-LICENSES.md
- [x] Privacy: aircraft digests out of detection and track ids (opaqueKey), out of track raw and detection meta
- [x] Fire backtest on the 7-day files; fire mask redesigned per 0.02 degree sub-cell; fireGrowthDue for the worker
- [x] Real ingest run 1: 2026-09-24 13:56 to 2026-09-25 04:30 UTC (Mac slept on battery 16:00 to 18:00 and 20:00 to 00:00 UTC; worker kept exact cadence while awake)
- [x] Circling calibrated on run 1 (88,864 samples): minTurnDeg 720 (10 episodes, 0 holds; 360 gave 192), continuous-track buffer (no split records)
- [x] Globe failure shows the app's own copy (Cesium panel off)
- [ ] Real ingest run 2 on the calibrated code (started 2026-09-25 04:33 UTC; stopped 04:40 UTC because the battery reached 4%)
- [ ] Frame rate with all layers on: measured 29.8 fps mean, 29.2 fps p5 on 2026-09-25 04:39 UTC, but on battery at 4% in Low Power Mode, which caps the GPU. Not valid; re-measure on power.
- [ ] Record fixtures (bounded live capture), calibrate detector thresholds, seed-demo with frozen clock
- [ ] Quake and circling firing rates on recorded data (plan 3: report how often each detector fires)
- [ ] Live brief with the real key (Nate's .env.local), 20-brief eval DB and eval run
- [ ] e2e tests: layer toggles with 0 console errors, brief click flies + citations, Ask, replay keyboard, credits in view
- [ ] Frame rate with all layers on (real app), remove the /spike route
- [ ] Phase 2 report

## Decisions and discoveries (Phase 2)

- Cesium is never bundled: Turbopack's production minifier emits an octal escape in a template literal when it bundles Cesium's source (the chunk fails to parse). @argus/globe loads Cesium's prebuilt Cesium.js at runtime; lint forbids runtime imports of `cesium`.
- satellite.js runs only on the server (serverExternalPackages): Turbopack hangs when it bundles it for a browser worker.
- `.claude/` (agent worktrees) is excluded from git, tsc, ESLint, and Prettier; Tailwind and tsc otherwise walk 4 GB of worktree copies.
- `pnpm-lock.yaml` is held out of git until stealth-scan decision 7: two random sha512 integrity hashes contain a case-insensitive substring of a listed term (0 hits with the proposed boundary rule).
- dayKeyLabel bug fixed (it named the next day west of 90 W); detection times use local solar noon.
- Circling detections and aircraft tracks built their ids from the aircraft digest; ids reach citations and the browser. Now opaqueKey(aircraft, episode start).
- Fire mask (plan 3c revised): the 1 degree day-presence mask removed 33 of 33 growth findings in the backtest (peak-season fire cells burn most days). Persistence now per 0.02 degree sub-cell; masked detections leave counts and evidence. 25 of 33 survive plus 3 revealed, with 3 history days (below the minimum of 5).
- fire retention 4 dates never left a day pair scorable (a pair spans 4 UTC dates and completes 2 dates later); now 6.
- The 7-day files hold 5 whole solar days, so a cold-started worker scores fire growth from 2 days after start.
- Schema 3: migrate() refuses an older database file (no upgrade path before release; rebuild with pnpm ingest).

## Waiting on Nate

- `.env.example` gained ARGUS_HASH_SECRET and ARGUS_TRUST_PROXY (names only). A local hook blocks staging any file named like `.env`, so the change is uncommitted. The brief requires committing `.env.example`.
- `.env.local` with ANTHROPIC_API_KEY for the live brief and the eval.

## Blockers

- None for the build. The live brief and the eval need ANTHROPIC_API_KEY in `.env.local` (Nate places it; never read or printed). Checked 2026-09-24 09:15: `.env.local` does not exist yet.

## Last check results

- 2026-09-24 09:56: 258 unit tests passed; typecheck, lint, format, check:copy, check:indexes clean; stealth 0 hits and gitleaks 0 on every commit and merged branch; build compiles 11 API routes, check-build 0 problems in 15 client chunks.
