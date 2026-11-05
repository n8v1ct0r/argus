# Argus: Phase 1 plan

Status: APPROVED by Nate on 2026-09-23 (decisions 1 to 5 in section 9: adsb.lol for flights, the drum record, all approvals as recommended). Written and revised the same day after an adversarial review (3 critics, 65 findings: 4 blockers, 34 major, 27 minor).

How the facts were gathered: 8 research agents and 8 adversarial verifiers read the live official pages on 2026-09-23 and made a few measured requests. They checked 325 claims: 299 confirmed, 26 corrected, 0 refuted. Every number below comes from a quoted primary page, a measurement, the brief, or is labeled as a proposal, an assumption, or an estimate. "Verifier" marks a correction the checker made.

## 1. Data sources: limits, terms, attribution, ingest plan

### 1a. Earthquakes: USGS real-time GeoJSON feeds

| | |
|---|---|
| Endpoint | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson` (rolling 24 h, updated every minute) |
| Auth | None. `access-control-allow-origin: *` |
| Rate limits | No published number; excess returns HTTP 429. Responses carry `cache-control: public, max-age=60`, so polling faster than 60 s returns nothing new. Honor `Expires`. |
| Terms | "USGS-authored or produced data and information are considered to be in the U.S. Public Domain." No USGS logo, no implied endorsement. |
| On-screen credit | "Earthquake data courtesy of the U.S. Geological Survey" (USGS's own pattern: "(Product or data name) courtesy of the U.S. Geological Survey") |
| Measured | 255 features, 182,298 bytes (22,901 gzipped), 2026-09-23 21:55 UTC. Types: 248 earthquake, 5 quarry blast, 2 explosion. 10 of 255 had merged ids. |
| Ingest | Every 5 min (publishing latency averages about 20 min outside the US, per the USGS FAQ). Store an immutable version per (event, `updated`). Resolve identity through the `ids` alias list, because the preferred `id` can change. When an event vanishes, check whether its id moved into another event's `ids` before marking it deleted (verifier: USGS also deletes duplicate solutions of real quakes). |
| Traps | Depth can be negative (10 of 255 at 22:10 UTC, verifier re-measure). Filter non-earthquake types with an explicit allow-list. `tsunami` is a flag, not a tsunami. |

### 1b. Satellites: CelesTrak GP data, propagated with satellite.js

| | |
|---|---|
| Endpoint | `https://celestrak.org/NORAD/elements/gp.php?GROUP={stations,visual}&FORMAT=csv` (OMM fields; never TLE) |
| Auth | None. Enforcement is per IP. |
| Rate limits | "Only download the data you need, when you are going to use it, and only download data once per update. For GP data, updates are once every 2 hours." A repeat download of `active` or `starlink` returns HTTP 403 (enforced since 2026-03-26; reproduced during research). 50 HTTP errors (301, 403, 404) in 2 hours sends the IP to the firewall. Clients must stop on any non-200. |
| Terms | CelesTrak publishes no license page. Upstream, "USSPACECOM has provided express blanket approval for transfer/redistribution of basic SSA data ... conditioned on appropriate citation." |
| On-screen credit | "Orbital elements: CelesTrak, GP data from USSPACECOM / 18th SDS via Space-Track.org. Positions computed with SGP4 (satellite.js, MIT)." |
| Measured | `stations`: 22 objects. `visual`: 156 objects (the groups overlap). `active`: 16,586 objects, 599 of them with 6-digit catalog numbers that TLE output drops, including a crewed Soyuz. |
| Ingest | Every 6 hours, one request per group, hard stop on any non-200, keep last-good data, alarm on element-set age. Store element sets, never positions. Browsers load element sets from Argus, never from CelesTrak. |
| Client | satellite.js 7.1.0 (MIT) `json2satrec` in a Web Worker. The MVP shows `stations` and `visual` only; "all active" is out of the MVP because it is not ingested. For scale: propagating all 16,586 active objects in pure JS took 64.3 ms median per sweep (Node 22 on a busy M5 Max, not a browser). |

### 1c. Natural events: NASA EONET v3

| | |
|---|---|
| Endpoint | `https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=3` |
| Auth | None. |
| Rate limits | Undocumented. Responses carry `X-RateLimit-Limit: 60`; the counter reset within about 90 s (verifier), consistent with 60 per minute. |
| Terms | "All EONET metadata and services are intended to be used for visualization and general information purposes only and should not be construed as “official” with regards to spatial or temporal extent." Upstream sources (GDACS, JTWC, NHC, IRWIN, and others) carry their own terms. |
| On-screen credit | "Natural events: NASA EONET", plus "Source: {upstream title}" per event, and the disclaimer in the layer's info panel. |
| Measured | `status=open` returns 7,187 events (7,117 wildfires, oldest geometry 2002). All 57 flood polygons in a 30-day sample were stored latitude-first; 1 geometry was dated in the future. |
| Ingest | Every 30 min; store a new version only when an event's hash changes (a `days=3` pull measured 268,344 bytes). Show only events with a geometry inside the replay window. Fix latitude-first polygons, drop future dates, never compare `magnitudeValue` across sources. EONET wildfires are hidden by default because FIRMS covers fires. |

### 1d. Wildfires: NASA FIRMS, keyless global files

| | |
|---|---|
| Endpoint | `https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv` and `.../noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv` |
| Auth | None. The brief expected a MAP_KEY; the global files returned HTTP 200 without one (measured), and FIRMS's own tutorial auto-refreshes the keyless KML versions of these files every 3600 s (verifier). The MAP_KEY Area API ("5000 transactions / 10-minute interval"; a world VIIRS day costs 36) stays an optional upgrade. |
| Rate limits | None published for the files; they are rebuilt every 60 minutes. The server ignores conditional GETs, so send a HEAD and download only when `Last-Modified` changes. |
| Terms | "This dataset is openly shared, without restriction". LANCE disclaimer: "their use for tactical decision-making or informing about conditions at a local scale are not advised." |
| On-screen credit | "Fire detections: NASA FIRMS (VIIRS 375 m, NOAA-20 and NOAA-21)". About page: "We acknowledge the use of imagery from the NASA LANCE FIRMS (https://earthdata.nasa.gov/firms), part of the NASA Earth Science Data and Information System (ESDIS).", plus both dataset DOIs. |
| Measured | NOAA-20 24 h file: 103,590 rows, 8,665,660 bytes (about 1.86 MB gzipped). NOAA-20 7-day file: 43,381,583 bytes. |
| Ingest | Hourly HEAD, GET on change. Each GET writes a new immutable version of the (satellite, acquisition date) batch, because FIRMS removes anomalous detections after publishing them (verifier). Skip Suomi NPP: its delivery ends 2026-11-01. |

### 1e. Flights: OpenSky fails rule 1 for this use. Recommended replacement: adsb.lol

**OpenSky Network, as the brief specifies**

| | |
|---|---|
| Auth | Anonymous still works (bucketed by IP). Accounts use OAuth2 client credentials only; Basic auth was switched off on 2026-03-18. |
| Credits | Per day, per endpoint bucket: anonymous 400, free account 4,000. A global `/states/all` costs 4 credits (measured 396 to 392); a box of 25 square degrees or less costs 1. Time resolution: 10 s anonymous, 5 s authenticated. |
| Measured | Global snapshot: 10,824 aircraft, 1,427,604 bytes, served uncompressed. |
| Terms | Clause added between the 2026-04-01 and 2026-05-01 archive snapshots: "Use of the REST API in any operational capacity — including integration into a live product, service, or automated system (even if only internal) — requires a previous written agreement, even for non-profit or governmental entities." Also: no making data available to anyone outside your institute (3(iii)), de-identify aircraft identifiers in anything published (3(i)), cite Schäfer et al. 2014, delete all copies when the research ends. The FAQ agrees: "Commercial entities and continued operational users must contact us for a license". The API docs warn AWS and other hyperscaler IPs may be blocked and say "Do not contact us because you want your AI dashboard whitelisted". A free account also lets OpenSky publish the requester's name and affiliation. |
| Verdict | An automated ingest feeding a public globe needs a written agreement that OpenSky signals it will not give. Even a standing local ingest loop counts as "an automated system (even if only internal)". The MVP ships no OpenSky code. |

**adsb.lol (recommended)**

| | |
|---|---|
| Endpoint | `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}`, radius 0 to 250 nm. No global endpoint: `/v2/all` was removed in 2023, and the network-wide API is feeder-only. |
| Auth | None today. A feeder-issued API key is announced with no date. |
| Rate limits | None published: "Rate limits are dynamic based on the environment load. If you get 4xx errors, you are doing something wrong." The server rejects generic User-Agents with 403 "User-Agent too generic; include valid contact info." (verifier reproduced it for Node's default). Third parties saw 429 at a 10 s interval, and one client stabilised only at 16 s spacing. |
| Argus request plan | One serial queue, at least 15 s between requests: the detector area every 30 s (2 a minute) and 3 layer areas every 10 min (0.3 a minute), 2.3 requests a minute in all. Stop on any 4xx and persist the backoff state. Step the detector to 20 s only after a 24 h local run with 0 responses of 429. |
| Terms | The live API spec says "You can use the API for free" and asks production users to "please contact me so I do not break your application by accident". ODbL 1.0 covers "the API as well as all data ADSB.lol makes public". ODbL allows public reuse with a notice (4.3); once Argus is publicly used, the flight-derived rows must be offered under ODbL (4.6a). The other layers are public domain or openly shared, so they can sit in the same database. Not legal advice. |
| On-screen credit | "Contains information from ADSB.lol (https://adsb.lol), which is made available here under the Open Database License (ODbL) (https://opendatacommons.org/licenses/odbl/1-0/)." Short form "ADSB.lol (ODbL)" in the persistent credits line. |
| Measured | 250 nm around JFK: 810 aircraft, 93,482 bytes gzipped. `track` present on 637 of 639 airborne aircraft; median position age 0.253 s. 66 aircraft carried the LADD flag (owner opted out of FAA display), all 66 with registration and position. |
| Privacy | Redaction happens before anything is stored (section 2). Never call `/v2/reg`, `/v2/hex`, `/v2/callsign`, `/v2/ladd`, or `/v2/pia`. |
| Coverage | Regional areas only: tiling Earth takes about 916 circles per sweep (researcher estimate), the heavy bot traffic the maintainer objects to. Areas (proposed, in config): London 250 nm around Heathrow (51.47, -0.45), New York 250 nm around JFK (40.64, -73.78), Los Angeles 250 nm around LAX (33.94, -118.41). The detector area is London, 60 nm, inside the London layer area. |
| Risks | A one-person hobby service with no availability guarantee (maintainer, 2026-09-19). The key requirement could land any day. Acceptance of AWS egress is untested. Plan: a "source unavailable" state and a contact email to the maintainer before any public deploy (Nate sends it). |

**Rejected on their own terms:** adsb.fi ("personal, non-commercial use only"; two public permission requests unanswered for 3 to 5 weeks), airplanes.live (keyless request got 403 "Please contact us"; its terms forbid building a database or using automated tools without written permission), ADS-B One (terms ban automated queries and public display; API repo archived 2023), ADS-B Exchange (no free tier; $10 a month; a public site counts as commercial), TheAirTraffic (operator's terms ban bots), FAA SCDS (US only, "ADS-B data is not available via SWIM", JMS only).

### 1f. Imagery and globe

| | |
|---|---|
| CesiumJS | 1.145.0, Apache-2.0. No Cesium ion token: the ion Community plan allows 1,000 imagery sessions a month (1 per page view), Bing through ion bans asset tracking and mixing with other imagery, and the bundled evaluation token's audience reads "Delete on November 1, 2026". |
| Day imagery | NASA GIBS `BlueMarble_ShadedRelief_Bathymetry`, EPSG:3857 `GoogleMapsCompatible_Level8`, keyless. GIBS asks only that bulk downloads over 1,000,000 tiles in 24 hours be coordinated in advance. |
| Night imagery | NASA Black Marble (VIIRS, 2016 composite). GIBS serves its tiles `no-store`, so Argus fetches one global image once (a single request, not a tile crawl), stores it at no more than 4096 by 2048 WebP in `public/imagery/black-marble/`, and loads it after first paint. Credit: "Night lights: NASA Black Marble (VIIRS, 2016), via NASA GIBS". |
| Fill | Natural Earth II tiles bundled with CesiumJS (public domain) under the poles and as the offline fallback. |
| On-screen credit | The Cesium logo credit stays in place. GIBS: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)." All credits use `showOnScreen: true` (Cesium's default hides them in a popup). |
| Limit | GIBS base imagery stops near 500 m per pixel, so close-ups on a detector hit look soft. Accepted for the MVP. |

## 2. Event schema

One store, one shape. Every layer record, detector finding, and Ask Argus count is a row in `events` in one SQLite database. "Every citation resolves to a stored event" is an application check across `briefs` and `events`, run inline, by `check-briefs`, and by a scheduled integrity test.

### `events`

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | Immutable version ID: `{source}:{native id}@{version}`. Examples: `usgs:us7000abcd@1790200000000` (USGS `updated`), `firms:J1:2026-09-22@{fetch_id}`, `celestrak:25544@2026-09-23T04:11:02Z`, `flights:frame:{fetch time}`, `argus:quake-cluster:{sha1(member version ids, thresholds)[0:12]}`. A row never changes after insert. |
| `record_key` | text | Upstream identity without version (`usgs:us7000abcd`), resolved through the USGS `ids` alias list. Detections group on this. |
| `source` | text | `usgs`, `celestrak`, `eonet`, `firms`, `flights` (provider in `facts`), `argus` (detectors and aggregates) |
| `kind` | text | `earthquake`, `satellite_elements`, `natural_event`, `fire_batch`, `fire_cell_day` (saved when a detection cites it), `flight_frame`, `aircraft_track` (saved when a detection cites it), `detection`, `aggregate` |
| `occurred_at` | integer (ms, UTC) | When it happened: origin time, acquisition time, element-set epoch, frame time |
| `fetched_at` | integer (ms, UTC) | When Argus received it |
| `source_updated_at` | integer, nullable | Upstream revision time (USGS `updated`, EONET geometry date) |
| `lat`, `lon` | real, nullable | Point or centroid, WGS84 degrees |
| `min_lat`, `min_lon`, `max_lat`, `max_lon` | real, nullable | Bounding box for areas and tracks |
| `title` | text | Short display line built by code |
| `facts` | JSON | Typed fields, each with the exact display string the model may copy: `{"mag": {"value": 4.6, "text": "4.6"}}`. Every number a sentence may use lives here: times, dates, distances, depths, counts, and any number inside a place name or title. |
| `raw` | text, nullable | The upstream record as received (GeoJSON feature, OMM CSV row, EONET event, the CSV lines behind a cell-day count). For flights, the redacted record (below). |
| `raw_gz` | blob, nullable | Gzipped batch for `fire_batch` and `flight_frame`. Exactly one of `raw` and `raw_gz` is set. |
| `raw_digest` | text | SHA-256 of the stored bytes, shown in the citation panel. For flights the label reads "as stored, identifiers removed". Hash fields are named `digest`, never `key` or `token`, so secret scanners do not flag them. |
| `fetch_id` | text | Fetch log row |
| `supersedes` | text, nullable | The previous version of the same `record_key` |

Indexes: `(kind, occurred_at)`, `(record_key)`, `(lat, lon)`.

### Supporting tables

| Table | Purpose |
|---|---|
| `fetches` | One row per source per hour (request count, bytes, last status), plus one row per error. Powers the live, stale, and error states. |
| `event_links` | `(parent_id, child_id)` for detections only, capped at 500 members per detection. |
| `fire_presence` | One row per (local solar day, satellite): gzipped per-cell counts, kept 30 days. Feeds the persistence mask. |
| `briefs` | Window, facts-pack hash, model, bullets JSON, checker result, token usage, cost in micro-dollars. |
| `model_cache` | `sha256(model, prompt version, canonical input)` to response JSON. Seeded from recorded fixtures in demo and CI. |
| `model_spend` | Per UTC day and route: tokens and micro-dollars. Enforces the daily caps. |
| `rate_limits` | `sha256(client, daily salt)`, window, count. IPv4 keyed per address, IPv6 per /64. Raw IPs are never stored or logged. |
| `backoff` | Per source: consecutive failures, next allowed time, last status. Survives restarts. |

### Rules the schema enforces

- Derived numbers are citable: "7 quakes" cites the detection whose `facts.count.text` is "7".
- Versions are immutable, so a brief's cited numbers never change under it. Retention never deletes a version that a live brief cites.
- Flight redaction, before anything is stored: keep only latitude, longitude, altitudes, ground speed, `track`, `seen_pos`, `category`, and a hashed ID. The hash is SHA-256 of the ICAO address with a 32-byte random salt that is generated per UTC day, held in memory only, and discarded at the end of the day; the previous day's mapping is held in memory until midnight plus 1 hour so an orbit in progress keeps its identity. Registration, owner, callsign, type, and squawk are dropped. LADD- and PIA-flagged aircraft are removed entirely. A unit test fails if `r`, `flight`, `ownOp`, or an unhashed ICAO address can reach the database.
- Committed flight fixtures carry IDs re-hashed with a fixed fake salt, and keep only large aircraft (ADS-B categories A3 to A5); other categories and aircraft without a category are removed.
- Bulk data is stored per fetch, not per point: one row per flight layer poll, one row per 5-minute batch of detector samples, one row per fire batch version.
- Retention: fire batches for the last 3 acquisition dates, `fire_presence` for 30 days, everything else 48 hours, except versions cited by a live brief.
- ODbL: once Argus is publicly used (Phase 6), a daily export of the flight-derived rows (frames, tracks, and detections that cite them), redacted, is offered under ODbL, per section 4.6a.
- No column, index, API parameter, or tool argument filters by aircraft identifier.

## 3. Detectors, the brief, and Ask Argus

Every threshold has a named key in `argus.config.ts`, the one config file, which also drives legend text and layer labels. A test fails if any detector module contains a numeric literal other than 0, 1, or 360. Values below are proposals; Phase 2 calibrates them on recorded data and reports how often each detector fires.

### 3a. Earthquake cluster

- Brief definition: [N] or more quakes within [R] km in [T] hours.
- Method (anchored window): for each quake A, the members are A plus every quake within `radiusKm` of A whose origin time falls in [A, A + `windowHours`]. At least `minCount` members makes a cluster. Overlapping clusters merge for display only; each stays its own citable detection. A cluster therefore can never span more than R km from its anchor or more than T hours.
- Inputs: USGS `type` in `quakeTypes` (proposed: `earthquake`, `induced or triggered event`), magnitude at or above `minMagnitude`. Quarry blasts and explosions are excluded.
- Proposed defaults: `minCount` 4, `radiusKm` 25, `windowHours` 6, `minMagnitude` 2.0. Without a magnitude floor the detector mostly measures network density: the 255-event day was led by networks ci (77), ak (45), and nc (33).
- Citable facts, all measured, never thresholds: `count`, `max_distance_km` (from the anchor), `span_hours`, `max_mag`, first and last time. Thresholds are stored under `thresholds` and labeled as such.
- Re-runs over the trailing window on every ingest, because non-US events post late and magnitudes get revised. Detections group on member `record_key`; a changed membership or member version creates a new detection that `supersedes` the old one.

### 3b. Circling aircraft

- Brief definition: heading changes that add up to 360 degrees or more within [T] minutes.
- Input: detector-area samples every `sampleSeconds` (proposed 30; 20 after a clean 24 h run, see 1e), airborne only, ground speed at least `minSpeedKt` (40), position age at most `maxPositionAgeS` (15), deduplicated on (aircraft hash, position time).
- Method: wrap each change in `track` between consecutive samples to (-180, 180]; a gap over `maxGapSeconds` (45) resets the sum. Fire when the absolute signed sum reaches `minTurnDeg` (360) within `windowMinutes` (proposed 6, which covers a 2-minute standard-rate orbit and a 4-minute racetrack hold).
- Physics limit: at 30 s spacing, turns faster than 6 degrees a second alias and are missed (9 degrees a second at 20 s). Standard-rate turns (3 degrees a second) are fine. Stated in the UI and README.
- Episodes: one detection per (aircraft hash, episode). While the aircraft keeps turning, a new version `supersedes` the last; there is no new detection per window. The facts pack carries at most `maxCirclingInBrief` (3) circling detections, ranked below quake clusters and fire growth, because Heathrow's holding stacks produce routine holds every morning.
- Citable facts: `total_turn_deg`, `direction`, `duration_s`, `sample_count`, altitude range, area name. The cited `aircraft_track` holds the redacted samples.
- Wording: the brief says an aircraft circled. It never speculates about who is aboard or why.
- Phase 2 calibration (recorded London samples of 2026-09-24 and 25: 88,864 samples, 1,761 aircraft): at `minTurnDeg` 360 the detector fired 192 times, mostly on training circuits at small airfields (98 below 2,000 ft) and Heathrow holds (32 at 7,000 ft or more). At 540 it fired 40 times, at 720 10 times, at 1080 3 times, with 0 holds from 540 up. `minTurnDeg` is now 720: at least 2 degrees a second held for the 6-minute window, such as 2 standard-rate orbits.
- Episodes longer than the window: the worker keeps each recently seen aircraft's continuous track, up to `maxEpisodeMinutes` (60), so an orbit keeps one start and one record. With only the last 11 minutes of samples, a batch-by-batch replay of the same data stored 262 records for 192 episodes at 360, and 12 for 10 at 720; with continuous tracks it stored none that the whole-run replay did not find.

### 3c. Fire growth

- Brief definition: the hotspot count in 1 area rises [X]% day over day.
- Area: a fixed `cellDeg` (1.0) cell, keyed `floor(lat),floor(lon)`. Research measured 0.5-degree cells as noisier. Measured scale: 4,829 cells at 1 degree held at least one detection across two 24 h files.
- Day: local solar day, `floor((utc_hours_since_epoch + lon / 15 - 6) / 24)`, so each satellite's night and day passes share a bin. That UTC midnight would split passes near longitude +20 and -160 degrees is an inference from published overpass times, not a measurement.
- Counts: confidence in `fireConfidence` (nominal, high), satellites NOAA-20 and NOAA-21, only when the same satellites reported on both days. A day is scored once it is complete plus `completenessMarginH` (6; verifier: NRT alerts can take up to 4 hours).
- Fires when `count_day0` is at least `minBaselineCount` and `count_day1` is at least `count_day0` times (1 + `minGrowthPct` / 100), compared on exact integers. The displayed percentage is floor((day1 - day0) / day0 times 100), computed by code.
- Proposed defaults: `minGrowthPct` 100, `minBaselineCount` 100 (both satellites summed, an assumption Phase 2 checks against NOAA-21). Basis, NOAA-20 only, binned by UTC day, one day pair (21 to 22 Sep 2026): with a baseline of at least 50, 4 of 237 cells doubled; at 100, 1 of 88; at 20, 34 of 598. The median cell swung by a factor of about 1.8 from overpass geometry alone, so a lower threshold would mostly fire on noise (inference).
- Persistence mask (revised in Phase 2, see below): a sub-cell of 0.02 degree (`persistenceSubcellsPerDeg` 50, about 2.2 km) is persistent (gas flares, refineries, volcanoes) when it had detections on at least `persistenceFraction` (0.6) of the days in `fire_presence`, excluding the two scored days. Detections in persistent sub-cells are left out of both days' counts and of the cited evidence; the rest of the cell still counts. The detector stays off until `persistenceMinDays` (5) days of history exist. Cold start: bootstrap `fire_presence` once from the 7-day files. FIRMS does not flag static heat sources, and its own mask "is not available for distribution". The brief calls these cells heat detections, not fires.
- Citable facts: `cell`, `count_day0`, `count_day1`, `growth_pct`, both dates, satellites. The two cited `fire_cell_day` events carry exactly the counted raw CSV lines; the worker drops a finding whose evidence count differs from the detector's.
- Phase 2 backtests on the 7-day files and must show at least one real growth cell surviving the mask (`scripts/backtest-fires.ts`).
- Phase 2 finding (backtest on the files of 2026-09-24: 888,149 rows, 5 whole local solar days, 18 to 22 Sep): the original mask judged whole 1 degree cells by day presence. Over 3 history days it marked 3,611 to 3,839 cells persistent and removed all 33 of 33 growth findings, because a peak-season fire cell burns on most days. A flare heats the same spot every day; a fire front rarely burns the same 2 km twice. Judged per 0.02 degree sub-cell (same 3 days, below the production minimum), 25 of the 33 findings survive and 3 new ones appear where flare detections had raised day 0 (5, 14, 4, and 5 findings per pair). The mask leaves out 19,710 of 119,537, 22,902 of 109,643, 29,500 of 111,169, and 23,196 of 100,538 day-0 detections. In a scratch run with the mask taken over all 5 days, 1,218 of 1,264 detections around the Basra flares fell in persistent sub-cells. The production mask needs 7 presence days, so after a cold start it switches on 2 days later.
- Retention keeps the newest 6 acquisition dates (`fireDates`): across longitudes a day pair spans 4 UTC dates and is complete only at 00:00 UTC two dates after its second day, so 4 kept dates (the first proposal) would never leave a pair scorable.

### 3d. The brief and its checker

- Cadence: every `briefEveryMinutes` (60), started by the ingest worker, which calls `POST /api/brief/run` on the Next server with a shared secret. No script or worker imports the Anthropic SDK; an ESLint rule allows `@anthropic-ai/sdk` only in `src/model/`, which only route handlers import.
- Input (facts pack): code selects current detections and a bounded set of notable events, each with its version ID, kind, and `facts.*.text`. Deterministic order, so identical data gives an identical hash.
- Output: schema-enforced JSON (structured outputs) `{ "bullets": [{ "text": string, "event_ids": string[] }] }`, exactly 5 bullets. The prompt forbids copying event titles, spelled-out numbers, and non-English text.
- Checker (`src/check/`, run inline before publishing and as `scripts/check-briefs.ts`):
  1. Every cited ID resolves to a stored event version.
  2. Normalize text with NFKC. Any Unicode digit other than ASCII 0 to 9 fails.
  3. One tokenizer runs on the sentence and on the cited events' `facts.*.text`: signed integers, decimals, thousands separators, percentages, clock times, ISO dates, `M4.6`-style magnitudes. Hyphens inside identifiers belong to the word. Every sentence token must exactly equal a token from the cited facts. `raw` is display-only and never part of the check.
  4. Number words and multipliers fail: English cardinals and ordinals (zero upward, including dozen, hundred, thousand, million, billion), and double, doubled, twice, triple, tripled, half, pair, and any word ending in -fold.
  5. Copy rules: 0 em or en dashes (U+2014, U+2013), 0 banned words (the list shared with `check-copy.ts`), first word capitalized.
  6. Event IDs never appear in the text.
- A golden test file pins the tokenizer with passing and failing sentences.
- On failure: one retry that includes the checker's list of offending tokens. If that fails, the previous brief stays up and the failure is logged.
- Eval (`pnpm eval:briefs`): runs against a frozen eval database (gitignored, never deployed) that holds at least 20 distinct days: USGS from a one-time FDSN backfill, EONET by date range, FIRMS from the 7-day files, flights from recorded days where available. It requires 20 pairwise-distinct facts-pack hashes, bypasses the cache, and reports: numbers missing from cited events (target 0), unresolved citations (target 0), first-try and final pass rates, and dash and banned-word counts. A brief that fails twice counts as a failure, never an exclusion. It has its own spend cap. The database and checker output are kept as Phase 2 evidence.

### 3e. Ask Argus

- `POST /api/ask`. Tools only read the store: `search_events` (kind, bounding box, time range, minimum magnitude, sort, limit 50), `get_events` (up to 20 IDs), `list_detections`, `count_events`.
- `count_events` saves its result as an `aggregate` event whose ID is a hash of the normalized query and member set (re-asking reuses the row). Members are stored as a list of at most 500 IDs in `facts`, not as link rows. Aggregates have their own daily write budget, stopped before ingest is affected.
- Aircraft appear only through detections: `search_events` never returns `flight_frame` or `aircraft_track`, and tool results never include the aircraft hash. No tool takes a callsign, ICAO address, or registration.
- At most 4 tool rounds, then a structured answer `{ sentences: [{ text, event_ids }] }`. The same checker runs; numbers in the visitor's question count only if they appear in cited facts. The cited events move the camera.

## 4. Map module boundary

`packages/globe` (workspace package `@argus/globe`) owns everything CesiumJS. The app owns data, time, and meaning.

```ts
createGlobe(container: HTMLElement, options: GlobeOptions): Promise<Globe>

interface Globe {
  setLayer(id: string, data: PointLayer | BillboardLayer | RingLayer | AreaLayer | PathLayer): void
  setLayerVisible(id: string, visible: boolean): void
  setTime(t: Date): void                          // clock and day/night terminator
  flyTo(target: { points?: LonLat[]; bbox?: BBox }, opts?: { reducedMotion?: boolean }): Promise<void>
  highlight(ids: string[]): void                  // cited events drawn in the Pen ink
  onPick(cb: (hit: { layerId: string; id: string } | null) => void): () => void
  getCamera(): CameraState; setCamera(s: CameraState): void   // share links (stretch)
  sampleFrameRate(ms: number, opts?: { forceContinuous?: boolean }): Promise<{ mean: number; p5: number }>
  destroy(): void
}
```

- Inside: `CesiumWidget` setup with an explicit base layer (never Viewer defaults), GIBS day imagery, the self-hosted night image with `dayAlpha` 0 and `nightAlpha` 1, ellipsoid terrain (terrain with vertex normals would silently disable the night blend), primitive collections, picking, camera and reduced motion, on-screen credits, the frame-rate sampler, and an optional React wrapper on a subpath.
- Outside: fetching, the database, satellite.js propagation (a web worker in the app emits plain positions), detectors, the brief, and all copy.
- Enforced by: the package's only runtime dependency is `cesium`; an ESLint `no-restricted-imports` rule blocks `@/`, `next/*`, app paths, and every ion API (`IonImageryProvider`, `IonResource`, `createWorldImageryAsync`, `createWorldTerrainAsync`) inside it; `Ion.defaultAccessToken` is set to an empty string so a stray ion call fails loudly; the package type-checks and tests on its own in CI.
- Static assets: a prebuild script copies `cesium`'s `Build/Cesium/{Workers,ThirdParty,Assets,Widgets}` (about 7.1 MB, verifier measurement) to `public/cesium`; `window.CESIUM_BASE_URL` is set at runtime inside an `ssr: false` client island. Copying from `@cesium/engine` instead would miss the WASM decoders (verifier).
- Kratos imports `@argus/globe` and brings its own layers. Kratos's stack is unknown, so the core stays framework-free.

## 5. Visual system

Mode: Operate. The visitor completes a task: read the brief, check a citation, replay a day.
Physical scene: a technical reviewer opens the link at a desk, often in the evening, and spends a few minutes clicking sentences and checking raw events. The globe is the brightest thing on screen. That scene and the chosen material both call for a dark ground.

### Direction: the drum record (impeccable seed 84087192, assigned)

Argus reads Earth the way a seismic station records it: a smoked-paper helicorder drum. A stylus scratches a white line through black soot, every event is a deflection, every gap is an outage, and the station's header block says exactly where the record came from.

- Thesis: time and provenance are the interface. It refuses the category default (neon HUD on black, glowing panels, cyan everything).
- First viewport at 1440x900: the globe is full-bleed. Left rail, 272px, "Sources": one row per layer with its live trace, toggle, and source line. Right rail, 400px, "Brief": five numbered bullets set as record annotations, with Ask Argus under them. The citation panel opens over the Brief rail, never over the Sources rail or the credits. Bottom band, 112px, "Replay": the drum strip. A persistent credits line sits directly above the drum strip.
- Credits line (both sizes, never covered by any panel or sheet): the short source name of every visible layer (for example "USGS · NASA FIRMS · NASA EONET · CelesTrak · ADSB.lol (ODbL)"), "NASA GIBS", the Cesium logo, and a link to /about for the full texts. A Playwright assertion in every screenshot checks that each visible layer's credit is in the viewport and uncovered.
- Signature interaction: the drum strip. It is a 24-hour record with one trace per layer: quakes are deflections scaled by magnitude, fires are density bands, flights are a count trace, natural events are tick marks. The stylus is a `role="slider"`: arrow keys step one frame, Page Up and Page Down step 1 hour, Home and End jump to the ends, and `aria-valuetext` reads the UTC time. Each brief bullet pins a numbered annotation onto the strip at its events' times. Open a bullet: the camera flies there, the cited events take the Pen ring, and the citation panel opens as a station header block (source, event ID, fetched at, digest), then the stored record. A keyboard-reachable list of visible events mirrors globe picking.
- Phone at 390x844: globe on top, drum strip under it, the credits line, and a bottom sheet with Brief, Sources, and Ask tabs. The phone view is a real layout, because figure 1.5 needs it.

Raises from declined challengers (each named for its donor):

- From the normalled jackfield: state is drawn by stroke pattern as well as color. Solid means live, dashed means stale, a gap means error, dotted means off. No status depends on color alone.
- From the nixie counter: every number sits in a fixed-width tabular field with its unit, and a changed count marks itself once instead of swapping silently.
- From the industrial quote grammar: every panel and control uses its literal name (Brief, Sources, Replay, Ask Argus, Citations), and an unavailable layer carries a hatch plus its reason in words.
- From the alphabet storm: a number in a sentence and the field it came from are one object. Hover or focus the number, and the matching field lights up in the stored record.
- From the generative identity: one config file drives thresholds, legend text, and layer labels.
- From the design annual plate section: attribution is a typeset credits line, never 9px gray footer text.

### Colors: 6 named, all semantic

Contrast ratios computed with the WCAG 2 formula (script output, 2026-09-23). Every text use passes AA (4.5:1). Panels use Soot and are separated by Graphite hairlines; there is no seventh raised-surface color.

| Name | Hex | Role | On Soot |
|---|---|---|---|
| Soot | #131211 | Ground and panels | n/a |
| Scratch | #ECE9E2 | Primary text, live traces, globe glyphs | 15.43:1 |
| Graphite | #A29E95 | Secondary text, hairlines, inactive and off states | 7.00:1 |
| Signal | #FF6B5A | Detector findings: a cluster, a circling aircraft, fire growth | 6.69:1 |
| Varnish | #E9B44C | Data health: stale or failed sources | 9.89:1 |
| Pen | #8DB0FF | Your attention: selection, cited events, links, focus ring | 8.72:1 |

Layers are told apart by glyph, not hue: flights are heading-rotated chevrons, quakes are rings sized by magnitude, satellites are dots, natural events use their category outline, and fires are hatched grid cells. Every glyph carries a 1px Soot halo. Against an assumed desert color (#D8C3A0, an estimate, not a sampled tile), Scratch computes to 1.42:1 and the halo to 10.90:1. Phase 2 samples real Blue Marble desert tiles and reports the measured ratios.

Honest risk: a mostly monochrome globe may read quieter in the hero shot than a rainbow of layer colors. If the Phase 2 hero looks flat, the fix is per-layer inks, which breaks the 6-color budget, so that call comes back to Nate.

### Type: 2 families, self-hosted through next/font (no runtime request to Google)

- Public Sans (the US Web Design System face; Argus's data comes from USGS and NASA): all UI text, tabular figures on.
- Overpass Mono (from the Overpass family, derived from Highway Gothic, the US federal highway signage face): event IDs, timestamps, coordinates, stored records. B612 Mono was the first pick and was rejected after a render test: at 12px its wide punctuation cells made "15.43:1" read as "15. 43: 1" and "21:55:30" as "21: 55: 30", which is unacceptable in a product whose point is checkable numbers.

| Token | Size / line height (px) | Use |
|---|---|---|
| caption | 12 / 16 | Credits, units, axis ticks (mono) |
| small | 13 / 18 | Metadata, citation field labels |
| body | 14 / 20 | Controls, lists, stored records (mono) |
| reading | 16 / 24 | Brief bullets, Ask answers |
| title | 20 / 26 | Panel titles |
| figure | 24 / 30 | The one headline count per panel |

Fixed rem scale; step ratios run from 1.077 (13 to 14) to 1.25 (16 to 20). Sentence case everywhere; no tracked uppercase labels. Tokens live as Tailwind v4 theme variables in `globals.css`.

### Components and motion

- Corners 0 or 2px. Panels are sheets flush to the rails, split by 1px Graphite hairlines. No shadows, no gradient washes, no card grids.
- Focus: a 2px Pen ring with a 2px offset on every control.
- State changes take 150 to 200 ms. Camera flights take 1.5 s. With prefers-reduced-motion, flights become an instant cut, camera inertia is off, the stylus stops auto-advancing, and nothing pulses.
- No entrance animations.

### Alternatives you can pick instead

- Impeccable's pick, the analytic brief: numbered judgments with bracketed source notes, set like a briefing document beside the globe. Honest risk: it is the most familiar option; answer engines with footnote chips already look like this.
- The category standard, played straight: a dark OSINT dashboard (charcoal panels, left layer list, right brief, one blue selection color, a workhorse sans). Legible and safe; indistinguishable from its neighbors.
- Declined challengers (their kept lines are the raises above): normalled jackfield, nixie counter, industrial quote grammar, alphabet storm, generative identity, design annual plate section.

## 6. File tree

```
argus/
├── .github/workflows/ci.yml         install, lint, typecheck, test, build (Phase 5; no Anthropic secret)
├── .env.example                     variable names only
├── .gitignore                       includes .local/ (brief, stealth list) and data/
├── CLAUDE.md  PRODUCT.md  README.md  LICENSE  DATA-LICENSES.md
├── argus.config.ts                  THE config: every threshold, cadence, area, cap, the model ID, layer labels
├── package.json  pnpm-workspace.yaml  tsconfig.json  eslint.config.mjs  .prettierrc.json
├── next.config.ts  postcss.config.mjs  playwright.config.ts
├── docs/plan.md
├── tasks/todo.md
├── packages/globe/                  @argus/globe, the module Kratos reuses
│   ├── package.json                 runtime dependency: cesium only
│   ├── src/index.ts                 createGlobe and public types
│   ├── src/globe.ts                 CesiumWidget, clock, lighting, render mode
│   ├── src/imagery.ts               GIBS day, self-hosted night, Natural Earth fill
│   ├── src/layers.ts                points, billboards, rings, areas, paths
│   ├── src/camera.ts                flyTo, reduced motion, camera state
│   ├── src/credits.ts               on-screen credits per layer
│   ├── src/fps.ts                   frame-rate sampler
│   ├── src/react.tsx                optional React wrapper (subpath export)
│   └── test/
├── public/imagery/black-marble/     the self-hosted night image
├── src/
│   ├── app/
│   │   ├── layout.tsx  page.tsx  globals.css (Tailwind v4 theme tokens)
│   │   ├── about/page.tsx           full citations, DOIs, disclaimers, licenses
│   │   └── api/
│   │       ├── layers/[layer]/route.ts   hour-aligned immutable chunks plus a 60 s live tail
│   │       ├── events/route.ts           event versions by ID, for the citation panel
│   │       ├── brief/route.ts            latest brief, no model call
│   │       ├── brief/run/route.ts        model route: secret, per-IP limit, daily cap
│   │       ├── ask/route.ts              model route: per-IP limit, daily cap
│   │       ├── status/route.ts           per-source freshness
│   │       └── flights/export/route.ts   ODbL export of flight-derived rows (Phase 6)
│   ├── components/                  Sources, Brief, Citations, AskArgus, Replay (drum strip), CreditsLine
│   ├── ingest/worker.ts             the long-running ingest worker (schedules every source)
│   ├── ingest/sources/              usgs.ts  celestrak.ts  eonet.ts  firms.ts
│   ├── ingest/sources/flights/      adapter.ts  adsblol.ts  redact.ts
│   ├── detectors/                   quake-cluster.ts  circling.ts  fire-growth.ts  fire-mask.ts
│   ├── brief/                       facts.ts  prompt.ts  generate.ts
│   ├── check/                       tokens.ts  check-brief.ts  copy-rules.ts
│   ├── ask/                         tools.ts  loop.ts
│   ├── model/                       call.ts (cache, replay mode, per-IP limit, spend cap)  pricing.ts
│   ├── db/                          client.ts (WAL, busy_timeout)  schema.sql  migrate.ts  queries.ts  retention.ts
│   ├── lib/                         geo.ts  time.ts  ids.ts  digest.ts  gzip.ts
│   └── workers/satellites.worker.ts satellite.js propagation
├── scripts/
│   ├── ingest.ts                    starts src/ingest/worker.ts (--once | --loop)
│   ├── record-fixtures.ts           one bounded capture of public data into fixtures/
│   ├── build-eval-db.ts             the 20-day frozen eval database
│   ├── seed-demo.ts                 clean DB, fixtures, recorded model outputs, frozen clock
│   ├── check-briefs.ts              rule 4 checker CLI
│   ├── eval-briefs.ts               20 briefs through /api/brief/run on the local server
│   ├── copy-cesium-assets.ts        prebuild: cesium Build/Cesium into public/cesium
│   ├── fetch-night-imagery.ts       one-time fetch of the Black Marble image
│   ├── measure-fps.ts               all layers on, continuous render, frame rate report
│   ├── check-copy.ts                dashes and banned words in UI text, README, portfolio kit
│   ├── stealth-scan.sh              reads .local/stealth-terms.txt; the terms never enter git
│   └── portfolio-capture.ts         pnpm portfolio:capture (replay mode, text scan before each shot)
├── fixtures/demo/                   recorded public data for the deterministic seed
│   ├── flights/LICENSE-ODbL.txt     ODbL notice for the redacted flight fixtures
│   └── model/                       recorded, checker-passing brief and Ask outputs keyed by input hash
├── tests/unit/                      detectors, tokenizer golden file, redaction, limits, cache
├── tests/e2e/                       layer toggles, brief click, Ask, replay, keyboard, credits in view, console errors
└── portfolio/
    ├── public/work/argus/           argus-1.0-hero-desktop.png and the rest
    ├── figures.json
    └── content/work/argus.mdx
```

Tooling notes:

- Pin TypeScript to 6.0.3. npm `latest` is 7.0.2, but typescript-eslint's peer range is `>=4.8.4 <6.1.0`.
- One test runner: Playwright Test (listed) runs the unit project (no browser) and the e2e project, so there is no Vitest and no tsx.
- Scripts run on Node 22's built-in type stripping (`process.features.typescript` is `strip` on this machine). Every module reachable from `scripts/` uses relative `.ts` imports and `erasableSyntaxOnly`, enforced by lint.
- SQLite runs in WAL mode with a busy timeout, because the worker and the Next server both write.
- Deterministic runs: `MODEL_MODE=replay` never calls the API and fails loudly on a cache miss. Capture, CI, and e2e run in replay mode against recorded outputs, so CI needs no Anthropic secret. Replay mode has its own rate-limit bucket, so repeated local runs cannot lock themselves out.
- Before each screenshot, the capture script scans `page.innerText()` against `.local/stealth-terms.txt` and a privacy pattern (emails, phone numbers) and fails the shot on a hit. gitleaks runs over fixtures in Phase 2, not first at publish time.
- Dependencies beyond the listed stack, needing your approval: `@anthropic-ai/sdk` (the Claude API) and `@libsql/client` 0.18.0 (the event store). Lighthouse runs through `npx` in Phase 3 and is not added to `package.json`.
- Data licenses: `DATA-LICENSES.md` lists every committed fixture's source, license, and credit. USGS, EONET, FIRMS, and CelesTrak fixtures ship with their credits; flight fixtures ship redacted with the ODbL notice. OpenSky data is never committed.

## 7. Storage, scheduler, and model routes

### Event store: SQLite through libSQL (Turso)

Pick: `@libsql/client` 0.18.0 against a local file (`file:./data/argus.db`) for dev, tests, CI, and screenshots. Hosted Turso Free is used only if Phase 6 deploys; same client, different URL.

Net benefit over Neon:

1. One client and one SQL dialect everywhere, with no server, no Docker, and no cloud. A clean state is deleting a file, which is exactly what the capture script needs.
2. 5 GB of storage against Neon Free's 0.5 GB, and no compute meter. Neon Free has 100 CU-hours a month; research estimated 72 to 120 CU-hours a month for a 15-minute ingest cadence alone, and Argus polls more often than that.
3. The detectors are plain TypeScript (distance math, grid counts, heading sums), so PostGIS buys nothing at this scale.

What it costs:

- Turso Free blocks the whole database, reads included, the moment any monthly metric is exceeded: "Once you exceed the limit on any single metric ... your databases are blocked". Limits: 10M rows written, 500M rows read, 5 GB. Quotas count per calendar month, VACUUM is disabled, and writes in aborted transactions still count (verifier).
- Write estimate (computed by a planning script from the cadences above): about 4,080 inserts a day, about 8,160 row operations once retention deletes match inserts, and about 32,640 billed writes a day at an assumed 4 index entries per row. That is about 1.01M a month, about 10.1% of the cap. Flights dominate the polling (2,880 detector polls and 432 layer polls a day) but are batched into 720 rows (432 layer frames, 288 detector batches). Assumptions, all to be measured in Phase 2: 1 revision per USGS event (255 measured), 50 changed EONET events, 3 new element sets per satellite a day (178 objects: 22 plus 156), a cap of 200 circling episodes, 20 quake clusters, 30 fire detections with evidence, 50 fetch error rows, 1,000 Ask rate-limit rows, 500 Ask aggregates.
- Guard, derived: 70% of 10M over 31 days is 225,806 billed writes a day, counted across every writer. Ask aggregates and rate-limit rows have their own budget inside it and stop first; ingest stops next. Every query uses an index, enforced by an `EXPLAIN QUERY PLAN` test.
- Turso's product line is in flux (a rewrite engine, new TS packages). New databases still default to libSQL (verifier), and the data is plain SQLite, so it can always be exported.

Considered and not picked: Neon made cron-triggered Functions and 5 GB of object storage generally available on 2026-09-18 (verifier-reported, not re-checked). That makes Neon a credible single-vendor deploy, but it is 5 days old and it forces a local Postgres server for dev and CI. The storage interface keeps a later swap to one module.

### Scheduler: one always-on ingest worker

Pick: `src/ingest/worker.ts`, a single long-running Node process started by `pnpm ingest --loop`. It schedules every source on its own cadence from `argus.config.ts` (USGS 5 min, EONET 30 min, FIRMS hourly HEAD, CelesTrak 6 h, flights per 1e, brief 60 min through `/api/brief/run`), runs one serial queue per source, takes a database lease so two workers never overlap, and persists backoff state.

- Phases 2 to 5: it runs on this Mac. Screenshots and CI use seeded fixtures, never live ingest.
- Phase 6 (optional deploy): the same worker needs an always-on host, because the circling detector samples every 30 s and no cron can do that. Where it runs (this Mac, a small VM, or a free tier) is a Phase 6 decision for Nate. Without such a host, a deploy shows recorded flights and runs the other sources from a cron.
- Not picked:
  - Vercel Cron on Hobby: "Once per day" at "±59 min" precision, and more frequent expressions fail at deploy.
  - GitHub Actions schedules: the terms say "You may only access and use GitHub Actions to develop and test your application(s)" and name "part of a serverless application" as disallowed. Enforcement can reach your personal GitHub account, which hosts the portfolio.
  - Upstash QStash calling a Vercel function that samples in a loop: a function held open about 110 s every 2 minutes would run most of the day on Hobby and exceed its limits (critic finding), and it would look like working around them.
  - Cloudflare Workers Free: 10 ms of CPU per cron trigger. Parsing one global flight frame took 9.0 ms and one FIRMS file 95 ms on a fast laptop.

### Model routes

- Model: `claude-haiku-4-5-20251001`. Live docs on 2026-09-23 list it as the Claude API ID (alias `claude-haiku-4-5`), $1 per million input tokens and $5 per million output tokens, 200K context, status Active, retirement "Not sooner than October 15, 2026". Anthropic gives at least 60 days' notice, and no deprecation notice exists yet. The ID lives in `argus.config.ts`.
- Haiku 4.5 supports structured outputs (`output_config.format`), so the brief's JSON shape is enforced by the API.
- Prompt caching needs a 4,096-token prefix on Haiku 4.5. The fixed part of the brief prompt (instructions plus schema) is estimated at about 1,500 tokens, below that minimum, so the "cache identical inputs" rule is met by Argus's own `model_cache` table.
- Every model call goes through one `callModel()` in `src/model/`, reached only from the two route handlers. It checks replay mode, the cache, the per-IP limit, and the daily cap (reserving the worst-case cost before the call and reconciling after), then records usage.
- Limits (config): `/api/ask` 5 questions per 10 minutes and 20 a day per client; `/api/brief/run` requires the scheduler secret and allows 12 calls an hour per client.
- Cost estimates (not measured; `budget.mjs`): a brief at about 8,000 input and 800 output tokens costs $0.012, or $0.024 with its one retry, so 24 a day is at most $0.576. An Ask call at about 4,000 input and 400 output tokens costs $0.006, and a question of up to 5 calls at most $0.03.
- Daily caps (config): briefs $1.00, Ask $1.00 (at least 33 worst-case questions), the eval its own $2.00 (20 briefs cost at most $0.48). Phase 2 measures real usage and reports it.
- `ANTHROPIC_API_KEY` is read only in `src/model/`, and a build check fails if any client chunk contains the variable's name.

## 8. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| The flights source named in the brief does not allow this use (see 1e) | adsb.lol behind a provider adapter; decision 1 |
| adsb.lol is a best-effort hobby service with an unpublished, dynamic rate limit and an announced key requirement | 2.3 requests a minute, at least 15 s apart, stop on any 4xx, persisted backoff, a "source unavailable" state, a contact email before any public deploy |
| Turbopack plus CesiumJS is proven only by third-party repos | Phase 2 opens with a spike using the real primitives at planned counts: about 2,400 heading-rotated flight chevrons (3 areas at up to about 810 aircraft each), 178 satellite dots, 255 quake rings, about 4,800 hatched fire cells, replay updates at 1 Hz. It reports mean and p5 frame rate, runs `next build`, renders day and night, and asserts that nothing calls api.cesium.com or virtualearth.net. Fallback: `next build --webpack`. |
| "All layers on" is ambiguous for the frame-rate criterion | Defined as: flights in all 3 areas, quakes, `stations` and `visual` satellites, EONET non-wildfire events, fire cells, continuous render forced during sampling. The report names the hardware and GL mode. |
| Turso Free blocks all reads when any quota is exceeded | Derived write guard, per-writer budgets, indexed queries, CDN-cached hour chunks |
| CelesTrak blocks per IP, and shared cloud egress counts other tenants | Default groups only, one request per slot, hard stop on non-200, element-set age alarm |
| Fire growth is the noisiest detector | Measured thresholds, a 30-day persistence mask, a 7-day backtest that must show a surviving growth cell |
| Model output varies between runs | Recorded outputs and replay mode for capture, CI, and e2e |
| The stealth scan must find every leak without false alarms | Case-insensitive substring match for every term; the 3-letter term alone uses a non-alphanumeric boundary, because it occurs inside base64 lockfile hashes (1 in 32,768 per 3-character window). Decision 7. |
| Vercel Hobby is "restricted to non-commercial personal use", and advertising services makes a deployment commercial | The Argus page carries no service promotion. The README affiliation line is your call at Phase 5. |
| Haiku 4.5 retirement "Not sooner than October 15, 2026" | Model ID in config; at least 60 days' notice |
| Headless WebGL | Playwright adds `--enable-unsafe-swiftshader`; on this Mac, new headless (`channel: 'chromium'`) used the Metal GPU in the research probe. Phase 4 reports which mode captured the shots. |
| GIBS base imagery stops near 500 m per pixel | Accepted for the MVP; detector close-ups look soft |

## 9. Decisions

Decided by Nate on 2026-09-23: 1 = adsb.lol (recommended option), 2 = the drum record, 3 = approved, 4 = `Argus/0.1 (+https://github.com/n8v1ct0r)`, 5 = Nate places `ANTHROPIC_API_KEY` in `.env.local`; Phase 2 model spend ceiling $5.00.

Original questions, kept for the record:

1. Flights source (1e). Recommended: adsb.lol, regional areas, ODbL notice and export, redaction before storage, LADD and PIA aircraft excluded. Alternatives: OpenSky only as manual, time-boxed research runs whose output is never committed or captured (no public flights layer, no OpenSky code in the repo), or drop flights and the circling detector.
2. Visual direction (5): the drum record (assigned), the analytic brief, or the category standard.
3. Approvals the brief requires: `@anthropic-ai/sdk` and `@libsql/client`; FIRMS through the keyless global files (no MAP_KEY); no Cesium ion token.
4. adsb.lol User-Agent contact. adsb.lol requires "valid contact info" and the repo does not exist until Phase 5. Recommended: your existing public GitHub profile, `Argus/0.1 (+https://github.com/n8v1ct0r)`. Alternatives: a dedicated project email alias, or creating the empty repo early (a hard stop you would approve).
5. `ANTHROPIC_API_KEY` in `.env.local` for Phase 2 (you place it; it never enters chat or git), with a Phase 2 model spend ceiling of $5.00 covering development, the eval ($0.48 at most), and recording the fixture outputs.

Needed later, recorded now:

6. Phase 6 host for the always-on ingest worker, and the contact email to the adsb.lol maintainer before any public deploy (drafted for you to send).
7. Stealth scan rule (by Phase 5): substring match for every term, with a non-alphanumeric boundary for the 3-letter term only.
8. README affiliation line (Phase 5), which also decides whether Vercel Hobby fits.

Non-blocking: what Kratos is built with (the globe core stays framework-free either way).
