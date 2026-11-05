import type { Metadata } from "next";
import Link from "next/link";
import { BLACK_MARBLE_CREDIT, GIBS_CREDIT } from "@argus/globe";
import { config } from "../../../argus.config.ts";

export const metadata: Metadata = {
  title: "Argus credits",
  description: "Data sources, licenses, citations, and disclaimers for Argus.",
};

const DATASETS: Array<{ title: string; lines: string[] }> = [
  {
    title: "Earthquakes: U.S. Geological Survey",
    lines: [
      "Earthquake data courtesy of the U.S. Geological Survey (ANSS Comprehensive Catalog).",
      "U.S. Geological Survey, Earthquake Hazards Program, 2017, Advanced National Seismic System (ANSS) Comprehensive Catalog of Earthquake Events and Products: Various, https://doi.org/10.5066/F7MS3QZH.",
      "USGS-authored data is in the U.S. public domain. Argus does not use the USGS logo and does not imply endorsement.",
    ],
  },
  {
    title: "Fires: NASA FIRMS",
    lines: [
      "We acknowledge the use of imagery from the NASA LANCE FIRMS (https://earthdata.nasa.gov/firms), part of the NASA Earth Science Data and Information System (ESDIS).",
      "NASA VIIRS Land Science Team. VIIRS NOAA-20 (JPSS-1) 375 m I-Band Active Fire Product NRT (Vector data). https://doi.org/10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002",
      "NASA VIIRS Land Science Team. VIIRS (NOAA-21/JPSS-2) I Band 375 m Active Fire Product NRT (Vector data). https://doi.org/10.5067/VIIRS/VJ214IMGTDL_NRT.002",
      "LANCE disclaimer: the data are provided as is; due to their spatial resolution and other characteristics, their use for tactical decision-making or informing about conditions at a local scale is not advised.",
      "FIRMS does not flag static heat sources such as gas flares, refineries, and volcanoes. Argus masks cells that report heat on most days and calls the rest heat detections.",
    ],
  },
  {
    title: "Flights: ADSB.lol",
    lines: [
      "Contains information from ADSB.lol (https://adsb.lol), which is made available here under the Open Database License (ODbL) (https://opendatacommons.org/licenses/odbl/1-0/).",
      "Argus removes registrations, callsigns, owners, aircraft types, and squawk codes before storing anything, replaces each aircraft address with a keyed digest that changes every UTC day, and drops aircraft whose owners opted out of display (LADD and PIA). Flight data covers three regional areas, not the whole Earth.",
    ],
  },
  {
    title: "Satellites: CelesTrak",
    lines: [
      "Orbital elements: CelesTrak (celestrak.org), GP data from USSPACECOM / 18th Space Defense Squadron via Space-Track.org.",
      "Positions are computed with SGP4 (satellite.js, MIT license) from mean elements. They are model estimates, not observations.",
    ],
  },
  {
    title: "Natural events: NASA EONET",
    lines: [
      "Natural events: NASA Earth Observatory Natural Event Tracker (EONET), with each event's upstream source named on the event.",
      "EONET disclaimer: all EONET metadata and services are intended to be used for visualization and general information purposes only and should not be construed as official with regards to spatial or temporal extent.",
    ],
  },
  {
    title: "Imagery",
    lines: [
      GIBS_CREDIT,
      `${BLACK_MARBLE_CREDIT}. Argus hosts one copy of this static 2016 composite.`,
      "Natural Earth II raster tiles bundled with CesiumJS (public domain) fill the poles.",
      "CesiumJS (Apache-2.0). Argus uses no Cesium ion services.",
    ],
  },
];

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-[72ch] px-4 py-10">
      <Link href="/" className="text-small">
        Back to the globe
      </Link>
      <h1 className="mt-6 text-figure font-semibold">Credits and sources</h1>
      <p className="mt-3 text-reading">
        Argus shows public data only. Every sentence in the brief cites stored events, and a check
        confirms that every number in it appears in those events.
      </p>
      {DATASETS.map((d) => (
        <section key={d.title} className="mt-8">
          <h2 className="text-title font-semibold">{d.title}</h2>
          <ul className="mt-2 flex flex-col gap-2 text-body">
            {d.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      ))}
      <section className="mt-8">
        <h2 className="text-title font-semibold">Model</h2>
        <p className="mt-2 text-body">
          The brief and Ask Argus use Claude ({config.model.id}) through a server route. The model
          writes sentences from computed results; code computes every number.
        </p>
      </section>
    </main>
  );
}
