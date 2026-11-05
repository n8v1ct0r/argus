# Worker fixtures

`usgs_swarm.json` is synthetic: a USGS `all_day.geojson` shaped FeatureCollection built for the ingest worker tests. The network code `zz`, the ids, the place names, and the `example.invalid` URLs are made up; no feature describes a real earthquake.

- `zz70000001` to `zz70000005`: five quakes within 3 km and 110 minutes of each other, magnitudes 2.2 to 3.4. The tests serve the first four, then all five, to see a cluster detection grow and supersede itself.
- `zz70000006`: a distant quake that never joins the cluster.
- `zz70000007`: a quarry blast inside the swarm, which the cluster detector must ignore.

Times start at 2026-09-24 06:00 UTC; `updated` is 10 minutes after each origin time.
