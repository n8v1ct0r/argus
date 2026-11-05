# Data licenses

Argus shows public data from 5 sources on a globe with NASA imagery. This file lists each source's terms and the credit Argus shows, then every data file committed to this repo and where it came from.

Each quote below is copied from the source's own terms page or API docs. This file is not legal advice.

## Sources

### Earthquakes: U.S. Geological Survey

- Feed: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`
- Terms: "USGS-authored or produced data and information are considered to be in the U.S. Public Domain." Argus uses no USGS logo and implies no endorsement.
- Credit on screen: "Earthquake data courtesy of the U.S. Geological Survey"
- Citation (About page): U.S. Geological Survey, Earthquake Hazards Program, 2017, Advanced National Seismic System (ANSS) Comprehensive Catalog of Earthquake Events and Products: Various, https://doi.org/10.5066/F7MS3QZH.

### Fires: NASA FIRMS

- Files: the keyless VIIRS 375 m global 24 h CSV files for NOAA-20 and NOAA-21.
- Terms: "This dataset is openly shared, without restriction". The LANCE disclaimer says the data's "use for tactical decision-making or informing about conditions at a local scale are not advised."
- Credit on screen: "Fire detections: NASA FIRMS (VIIRS 375 m, NOAA-20 and NOAA-21)"
- Acknowledgement (About page): "We acknowledge the use of imagery from the NASA LANCE FIRMS (https://earthdata.nasa.gov/firms), part of the NASA Earth Science Data and Information System (ESDIS)."
- Dataset DOIs: https://doi.org/10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002 (NOAA-20) and https://doi.org/10.5067/VIIRS/VJ214IMGTDL_NRT.002 (NOAA-21).

### Flights: ADSB.lol

- API: `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}` only. Argus never calls the lookup endpoints by registration, hex address, or callsign, and never calls the LADD or PIA lists.
- Terms: the API spec says "You can use the API for free". The Open Database License (ODbL) 1.0 covers "the API as well as all data ADSB.lol makes public".
- Credit on screen: "Contains information from ADSB.lol (https://adsb.lol), which is made available here under the Open Database License (ODbL) (https://opendatacommons.org/licenses/odbl/1-0/)." The credits line uses the short form "ADSB.lol (ODbL)".
- What Argus stores: redacted samples only. Redaction runs before storage. It drops aircraft flagged LADD or PIA and aircraft without a position. It keeps position, altitude, speed, track, and emitter category. It replaces the aircraft address with a keyed digest whose daily key lives only in memory. No callsign, registration, or address is stored.
- Share-alike: flight-derived rows Argus makes public are offered under the ODbL. The committed flight fixtures carry the notice in `fixtures/demo/flights/LICENSE-ODbL.txt`.

### Satellites: CelesTrak

- Data: GP element sets as OMM CSV for the `stations` and `visual` groups.
- Terms: CelesTrak publishes no license page. Upstream, "USSPACECOM has provided express blanket approval for transfer/redistribution of basic SSA data ... conditioned on appropriate citation."
- Credit on screen: "Orbital elements: CelesTrak, GP data from USSPACECOM / 18th SDS via Space-Track.org. Positions computed with SGP4 (satellite.js, MIT)."

### Natural events: NASA EONET

- API: `https://eonet.gsfc.nasa.gov/api/v3/events`
- Terms: "All EONET metadata and services are intended to be used for visualization and general information purposes only and should not be construed as “official” with regards to spatial or temporal extent." Each event's upstream source (for example GDACS, JTWC, NOAA NHC, or IRWIN) carries its own terms.
- Credit on screen: "Natural events: NASA EONET", plus the upstream source title for each event.

### Imagery and globe

- Day imagery: NASA GIBS `BlueMarble_ShadedRelief_Bathymetry`, keyless. Acknowledgement: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."
- Night imagery: NASA Black Marble (VIIRS, 2016), fetched once through GIBS. Credit: "Night lights: NASA Black Marble (VIIRS, 2016), via NASA GIBS".
- Fill imagery: Natural Earth II, bundled with CesiumJS, public domain.
- Globe engine: CesiumJS 1.145.0, Apache-2.0. The Cesium credit stays on screen. Argus uses no Cesium ion token and no Bing imagery.

## Committed data files

| Path                                                      | Source                     | How it was made                                                                                                                           |
| --------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `public/imagery/black-marble/black-marble-2016-4096.webp` | NASA Black Marble via GIBS | One GIBS WMS request for layer `VIIRS_Black_Marble` at 4096 by 2048 (`scripts/fetch-night-imagery.ts`), converted to WebP. 273,436 bytes. |
| `tests/fixtures/usgs/*`                                   | USGS                       | Captured responses trimmed to 6 features, plus 1 derived revision. Details in `tests/fixtures/usgs/README.md`.                            |
| `tests/fixtures/celestrak/*.csv`                          | CelesTrak                  | 8 `stations` rows and 5 `visual` rows, each byte-identical to the responses captured 2026-09-24 02:04 UTC.                                |
| `tests/fixtures/eonet/*.json`                             | NASA EONET                 | 5 real events and the 4 source entries they use, trimmed from responses of 2026-09-24.                                                    |
| `tests/fixtures/firms/sample.csv`                         | None (synthetic)           | 40 made-up rows in the FIRMS column layout. No real detections.                                                                           |
| `tests/fixtures/flights/point-synthetic.json`             | None (synthetic)           | Made-up aircraft in the ADSB.lol response layout. No real aircraft.                                                                       |
| `tests/fixtures/check/golden.json`                        | None (synthetic)           | Test cases for the brief checker.                                                                                                         |

OpenSky Network data is never committed and Argus ships no OpenSky code.
