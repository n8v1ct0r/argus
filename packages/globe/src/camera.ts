import type { Camera, Rectangle } from "cesium";
import type { Cesium } from "./runtime.ts";
import type { BBox, CameraState, LonLat } from "./types.ts";

const FLIGHT_SECONDS = 1.5;
// Keep single-point and tight clusters from zooming to street level.
const MIN_SPAN_DEG = 18;

export function boundsOf(points: LonLat[]): BBox {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const [lon, lat] of points) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, south, east, north };
}

export function padded(C: Cesium, b: BBox, minSpanDeg = MIN_SPAN_DEG): Rectangle {
  const cx = (b.west + b.east) / 2;
  const cy = (b.south + b.north) / 2;
  const halfW = Math.max((b.east - b.west) * 0.75, minSpanDeg / 2);
  const halfH = Math.max((b.north - b.south) * 0.75, minSpanDeg / 2);
  return C.Rectangle.fromDegrees(
    Math.max(cx - halfW, -180),
    Math.max(cy - halfH, -89.9),
    Math.min(cx + halfW, 180),
    Math.min(cy + halfH, 89.9),
  );
}

export function flyTo(
  C: Cesium,
  camera: Camera,
  target: { points?: LonLat[]; bbox?: BBox },
  reducedMotion: boolean,
  minSpanDeg?: number,
): Promise<void> {
  const bbox = target.bbox ?? (target.points?.length ? boundsOf(target.points) : null);
  if (!bbox) return Promise.resolve();
  const destination = padded(C, bbox, minSpanDeg);
  if (reducedMotion) {
    camera.setView({ destination });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    camera.flyTo({
      destination,
      duration: FLIGHT_SECONDS,
      complete: () => resolve(),
      cancel: () => resolve(),
    });
  });
}

export function getCamera(C: Cesium, camera: Camera): CameraState {
  const c = C.Cartographic.fromCartesian(camera.positionWC);
  return {
    lon: C.Math.toDegrees(c.longitude),
    lat: C.Math.toDegrees(c.latitude),
    heightMeters: c.height,
    headingDeg: C.Math.toDegrees(camera.heading),
    pitchDeg: C.Math.toDegrees(camera.pitch),
  };
}

export function setCamera(C: Cesium, camera: Camera, s: CameraState): void {
  camera.setView({
    destination: C.Cartesian3.fromDegrees(s.lon, s.lat, s.heightMeters),
    orientation: {
      heading: C.Math.toRadians(s.headingDeg),
      pitch: C.Math.toRadians(s.pitchDeg),
      roll: 0,
    },
  });
}
