// One-time fetch of the NASA Black Marble night-lights composite (VIIRS, 2016) as a single
// global equirectangular image, through one GIBS WMS request (not a tile crawl).
// GIBS serves Black Marble tiles with `cache-control: no-store`, so Argus self-hosts the
// static composite instead of refetching tiles on every pan. Credit shown on screen:
// "Night lights: NASA Black Marble (VIIRS, 2016), via NASA GIBS".
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WIDTH = 4096;
const HEIGHT = 2048;
const outDir = join(process.cwd(), "public", "imagery", "black-marble");
const jpg = join(outDir, `black-marble-2016-${WIDTH}.jpg`);
const webp = join(outDir, `black-marble-2016-${WIDTH}.webp`);

if (existsSync(webp)) {
  console.log(`night image already present: ${webp}`);
  process.exit(0);
}

const url =
  "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0" +
  `&LAYERS=VIIRS_Black_Marble&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${WIDTH}&HEIGHT=${HEIGHT}` +
  "&FORMAT=image/jpeg&TIME=2016-01-01";

const res = await fetch(url, {
  headers: { "User-Agent": "Argus/0.1 (+https://github.com/n8v1ct0r)" },
});
if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) {
  console.error(`GIBS returned ${res.status} ${res.headers.get("content-type")}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(jpg, Buffer.from(await res.arrayBuffer()));

try {
  execFileSync("cwebp", ["-quiet", "-q", "80", jpg, "-o", webp]);
  rmSync(jpg);
  console.log(`wrote ${webp} (${statSync(webp).size} bytes)`);
} catch {
  console.log(`cwebp unavailable; keeping ${jpg} (${statSync(jpg).size} bytes)`);
}
