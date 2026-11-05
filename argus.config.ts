// THE config. Every detector threshold, cadence, area, cap, and the model ID lives here, and
// the UI reads its layer labels and credits from here, so the legend can never disagree with a
// detector. Values marked "proposal" are Phase 1 proposals that Phase 2 calibrates on recorded
// data (docs/plan.md section 3).

export const config = {
  // Contact User-Agent for every source request (adsb.lol requires contact info; decision 4).
  userAgent: "Argus/0.1 (+https://github.com/n8v1ct0r)",

  model: {
    // Confirmed in the live Anthropic docs on 2026-09-23 (Claude API ID, status Active).
    id: "claude-haiku-4-5-20251001",
    usdPerMillionInputTokens: 1,
    usdPerMillionOutputTokens: 5,
    briefMaxTokens: 2000,
    askMaxTokens: 1200,
  },

  caps: {
    briefUsdPerDay: 1.0,
    askUsdPerDay: 1.0,
    evalUsdTotal: 2.0,
  },

  rateLimits: {
    ask: { perTenMinutes: 5, perDay: 20 },
    briefRun: { perHour: 12 },
  },

  cadence: {
    usgsSeconds: 300,
    eonetSeconds: 1800,
    firmsHeadSeconds: 3600,
    celestrakSeconds: 21600,
    briefMinutes: 60,
    flightsDetectorSeconds: 30,
    flightsLayerSeconds: 600,
    flightsMinSpacingSeconds: 15,
    flightsDetectorBatchSeconds: 300,
  },

  retention: {
    hours: 48,
    // Across all longitudes, local solar day d spans UTC dates d-1 to d+1, so the pair (d-1, d)
    // spans d-2 to d+1 and is complete at 00:00 UTC on d+2 (18:00 at -180 plus the 6 h margin).
    // Scoring it then needs the newest 5 dates; 6 leaves room for a late batch.
    fireDates: 6,
    firePresenceDays: 30,
  },

  writeGuard: {
    // 70% of Turso Free's 10M monthly row writes over 31 days, in billed writes.
    billedWritesPerDay: 225_806,
    // Assumed billed writes per row write (the row plus its index entries).
    indexFactor: 4,
    askWritesPerDay: 20_000,
  },

  sources: {
    usgs: {
      url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
      fdsnUrl: "https://earthquake.usgs.gov/fdsnws/event/1/query",
    },
    celestrak: {
      url: "https://celestrak.org/NORAD/elements/gp.php",
      groups: ["stations", "visual"],
    },
    eonet: {
      url: "https://eonet.gsfc.nasa.gov/api/v3/events",
      days: 3,
    },
    firms: {
      files: {
        N20: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv",
        N21: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv",
      },
    },
    flights: {
      baseUrl: "https://api.adsb.lol/v2/point",
      layerAreas: [
        { id: "london", name: "London", lat: 51.47, lon: -0.45, radiusNm: 250 },
        { id: "new-york", name: "New York", lat: 40.64, lon: -73.78, radiusNm: 250 },
        { id: "los-angeles", name: "Los Angeles", lat: 33.94, lon: -118.41, radiusNm: 250 },
      ],
      detectorArea: { id: "london-detector", name: "London", lat: 51.47, lon: -0.45, radiusNm: 60 },
      // Committed fixtures keep only large aircraft (ADS-B emitter categories).
      fixtureCategories: ["A3", "A4", "A5"],
    },
  },

  detectors: {
    quakeCluster: {
      minCount: 4, // [N] proposal
      radiusKm: 25, // [R] proposal
      windowHours: 6, // [T] proposal
      minMagnitude: 2.0, // proposal
      quakeTypes: ["earthquake", "induced or triggered event"],
    },
    circling: {
      sampleSeconds: 30, // 20 after a clean 24 h run with 0 responses of 429
      windowMinutes: 6, // [T] proposal
      // Calibrated 2026-09-25 on 88,864 recorded London samples (1,761 aircraft): at 360 the
      // detector fired 192 times, mostly on training circuits (98 below 2,000 ft) and Heathrow
      // holds (32 at 7,000 ft or more). At 720 (at least 2 deg/s held for the window) it fired
      // 10 times, none of them holds.
      minTurnDeg: 720,
      // The worker keeps an aircraft's continuous track this far back, so an orbit longer than
      // the window keeps one episode start and one record.
      maxEpisodeMinutes: 60,
      minSpeedKt: 40,
      maxGapSeconds: 45,
      maxPositionAgeS: 15,
      maxCirclingInBrief: 3,
    },
    fireGrowth: {
      cellDeg: 1,
      minBaselineCount: 100, // both satellites summed; proposal checked against NOAA-21
      minGrowthPct: 100, // [X] proposal
      fireConfidence: ["nominal", "high"],
      completenessMarginH: 6,
      persistenceFraction: 0.6,
      persistenceMinDays: 5,
      // Persistence is judged per sub-cell of 1/50 degree (0.02, about 2.2 km): a flare heats the
      // same spot every day, a moving fire front rarely does. Detections in persistent sub-cells
      // are left out of the counts; the rest of the cell still counts.
      persistenceSubcellsPerDeg: 50,
      satellites: ["N20", "N21"],
    },
  },

  brief: {
    everyMinutes: 60,
    bullets: 5,
    maxRetries: 1,
    maxEventsInFactsPack: 60,
  },

  ask: {
    maxToolRounds: 4,
    maxAggregateMembers: 500,
    searchLimit: 50,
    getEventsLimit: 20,
  },

  layers: [
    {
      id: "quakes",
      label: "Earthquakes",
      glyph: "rings",
      shortCredit: "USGS",
      credit: "Earthquake data courtesy of the U.S. Geological Survey",
      creditUrl: "https://earthquake.usgs.gov/earthquakes/feed/",
    },
    {
      id: "fires",
      label: "Fires",
      glyph: "hatched cells",
      shortCredit: "NASA FIRMS",
      credit: "Fire detections: NASA FIRMS (VIIRS 375 m, NOAA-20 and NOAA-21)",
      creditUrl: "https://firms.modaps.eosdis.nasa.gov/",
    },
    {
      id: "flights",
      label: "Flights",
      glyph: "chevrons",
      shortCredit: "ADSB.lol (ODbL)",
      credit:
        "Contains information from ADSB.lol (https://adsb.lol), which is made available here under the Open Database License (ODbL) (https://opendatacommons.org/licenses/odbl/1-0/).",
      creditUrl: "https://adsb.lol",
    },
    {
      id: "satellites",
      label: "Satellites",
      glyph: "dots",
      shortCredit: "CelesTrak",
      credit:
        "Orbital elements: CelesTrak, GP data from USSPACECOM / 18th SDS via Space-Track.org. Positions computed with SGP4 (satellite.js, MIT).",
      creditUrl: "https://celestrak.org",
    },
    {
      id: "events",
      label: "Natural events",
      glyph: "outlines",
      shortCredit: "NASA EONET",
      credit: "Natural events: NASA EONET",
      creditUrl: "https://eonet.gsfc.nasa.gov",
    },
  ],
} as const;

export type ArgusConfig = typeof config;
export type LayerId = (typeof config.layers)[number]["id"];
