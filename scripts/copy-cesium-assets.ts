// Copies CesiumJS's static runtime assets into public/cesium so the browser can load
// workers, WASM decoders, textures, and widget CSS from our own origin.
// Source is the combined `cesium` package's Build/Cesium (it includes the WASM decoders
// that @cesium/engine keeps in a separate folder). Output is gitignored.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cesiumPkg = require.resolve("cesium/package.json");
const cesiumVersion: string = JSON.parse(readFileSync(cesiumPkg, "utf8")).version;
const buildDir = join(dirname(cesiumPkg), "Build", "Cesium");
const outDir = join(process.cwd(), "public", "cesium");
const stamp = join(outDir, ".version");

if (
  existsSync(stamp) &&
  readFileSync(stamp, "utf8") === cesiumVersion &&
  existsSync(join(outDir, "Cesium.js"))
) {
  console.log(`cesium assets ${cesiumVersion} already in public/cesium`);
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const dir of ["Workers", "ThirdParty", "Assets", "Widgets"]) {
  cpSync(join(buildDir, dir), join(outDir, dir), { recursive: true });
}
// The prebuilt bundle @argus/globe loads at runtime (see packages/globe/src/runtime.ts).
cpSync(join(buildDir, "Cesium.js"), join(outDir, "Cesium.js"));
writeFileSync(stamp, cesiumVersion);
console.log(`copied cesium ${cesiumVersion} assets to public/cesium`);
