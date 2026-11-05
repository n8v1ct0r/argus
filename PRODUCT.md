# Product

<!-- impeccable:product-schema 1 -->

Status: drafted 2026-09-23 from the Sidequest 01 brief; confirmed by Nate's Phase 1 approval the same day. Items marked [inferred] were inferred from the brief and approved with the plan.

## Platform

web

## Stack

Pinned by the brief: Next.js (App Router), TypeScript, Tailwind CSS, CesiumJS, Playwright for screenshots. Event store and scheduler are proposed in docs/plan.md and decided at the Phase 1 checkpoint.

## Users

- Primary [inferred]: a technical reader of Nate's portfolio (engineer, founder, or hiring manager) on a desktop browser. Their job: decide in under a minute whether the AI output can be trusted, by clicking a sentence and checking the raw events behind it.
- Secondary [inferred]: an OSINT-curious visitor who wants to see what is happening on Earth now and replay the last 24 hours.
- Operator: Nate, running Argus locally, reseeding it, and capturing portfolio figures with one command.

## Product Purpose

Argus is an open-source, real-time view of Earth (flights, earthquakes, satellites, natural events, wildfires) plus an AI analyst whose every sentence links to the raw events behind it. Success: every number in every brief appears in the events that brief cites, a script proves it, and a reader can see that proof from the interface.

## Positioning

Open-source OSINT dashboards put data on a map. Argus also explains the data, and a reader can check every sentence against its source. Code computes every number; the model only writes sentences from computed results.

## Operating Context

- Primary viewport 1440px desktop. 390px phone must work, or show "Best on desktop" where the brief allows it.
- Data comes only from public, free sources, polled on a schedule and stored with source, fetch time, and raw payload.
- Portfolio figures are produced by a scripted, repeatable Playwright capture from a clean, seeded state.

## Capabilities and Constraints

- Layers, each with its own toggle and on-screen source attribution: flights, USGS earthquakes, CelesTrak satellites (satellite.js), NASA EONET natural events, NASA FIRMS wildfires.
- Decided 2026-09-23 (docs/plan.md section 9): flights come from adsb.lol (ODbL; the brief named OpenSky, whose current terms forbid this use), and FIRMS data comes from the keyless global files (no MAP_KEY). Visual direction: the drum record.
- A time scrubber replays the last 24 hours of stored events.
- Deterministic detectors (earthquake cluster, circling aircraft, fire growth) with every threshold in one config file.
- The brief: 5 bullets as JSON, each listing the event IDs it cites. Clicking a bullet flies the camera to its events and opens a citation panel with the raw events.
- Ask Argus: the model answers only through tools that query the event store, cites event IDs, and moves the camera.
- Model calls run only on the server, with a per-IP rate limit, a daily spend cap, and a cache for identical inputs.
- Never built: port scanning, vulnerability scanning, camera feeds, search by aircraft tail number or owner.
- Cesium and imagery credits stay visible everywhere, including screenshots.

## Brand Commitments

- Name: Argus.
- Copy rules for all UI text, the README, and the portfolio kit: no em dashes or en dashes; none of the banned words listed in the brief; every claim carries a number or the flag "[needs a number]"; numbers copied exactly, never rounded, totaled, or combined; short sentences, active voice, plain words, sentence case.
- A dark theme is allowed for this ops view. Status colors are semantic; there is no single decorative accent.
- Ruled out: a cream background with a serif display and a terracotta accent; identical rounded cards with soft shadows; decorative gradient washes; arrows appended to link text; fade-in animations on every section.

## Evidence on Hand

None yet. There are no users, traction, benchmarks, or measurements. Every number in the case study or README must come from a test, an eval, a measurement, or the brief; otherwise it is written as "[needs a number]".

## Product Principles

1. Every sentence is checkable: a claim without cited events does not ship.
2. Code computes, the model narrates: counts, distances, and percentages come from detectors and tools, never from the model.
3. Attribution is part of the interface, not a footer afterthought.
4. Privacy by construction [inferred]: no identity lookups, no enrichment of aircraft with registration or owner data, no visitor location without opt-in.
5. Honest states [inferred]: loading, empty, error, and stale data are shown plainly, with the age of the data.

## Accessibility & Inclusion

WCAG AA text contrast, full keyboard operation with visible focus, and prefers-reduced-motion stops all non-essential motion (including camera flights).
