// Distance math for detectors. Plain TypeScript, no GIS dependency.

export const EARTH_RADIUS_KM = 6371.0088; // IUGG mean Earth radius
export const KM_PER_NM = 1.852;
export const MS_PER_KNOT = 0.514444;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometers (haversine). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Smallest signed difference between two headings, in (-180, 180]. */
export function headingDelta(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** Bounding box of a circle (approximate at high latitudes, fine for prefilters). */
export function bboxAround(lat: number, lon: number, radiusKm: number) {
  const dLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const dLon = dLat / Math.max(Math.cos(rad(lat)), 0.01);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}
