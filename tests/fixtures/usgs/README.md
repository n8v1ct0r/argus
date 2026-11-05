# USGS fixtures

Earthquake data courtesy of the U.S. Geological Survey. USGS-authored data is in the U.S. public domain.

- `all_day_sample.json`: one response from `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`, captured 2026-09-24 02:08 UTC (271 features). Trimmed to 6 features, each byte-identical to the response: ci41337919 (negative depth), ci41337911 (quarry blast), nc75440422 and hv75042652 (merged ids), us6000tx3m, and us6000tx29. `metadata.count` and `bbox` were recomputed for the 6 features.
- `fdsn_deleted_409.txt`: the body of `https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=nn00924808&format=geojson`, HTTP 409 for an event USGS deleted, captured 2026-09-24 02:18 UTC.
- `all_day_revision.json`: derived from the sample, not captured. `metadata.generated` is 10 minutes later. us6000tx29 has a new `updated` and magnitude 5.4 (was 5.3). nc75440422 changed its preferred id to nn00924795, which was already in its `ids` list, with a new `updated`, magnitude 2.6, and magType ml.
