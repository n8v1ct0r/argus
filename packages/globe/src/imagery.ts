// Keyless imagery stack, bottom to top:
// 1. Natural Earth II (bundled with CesiumJS, public domain): polar fill and offline fallback.
// 2. NASA GIBS Blue Marble shaded relief (EPSG:3857, GoogleMapsCompatible_Level8, about 500 m/px).
// 3. NASA Black Marble 2016 night lights, one self-hosted equirectangular image, night side only.
// The night blend needs ellipsoid terrain: terrain with vertex normals switches Cesium to
// vertex lighting and the night layer disappears.
import type { ImageryLayer } from "cesium";
import { BLACK_MARBLE_CREDIT, GIBS_CREDIT } from "./credits.ts";
import type { Cesium } from "./runtime.ts";

const GIBS_DAY_URL =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{TileMatrix}/{TileRow}/{TileCol}.jpeg";

export function naturalEarthLayer(C: Cesium): ImageryLayer {
  return C.ImageryLayer.fromProviderAsync(
    C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl("Assets/Textures/NaturalEarthII")),
    {},
  );
}

export function gibsDayLayer(C: Cesium, credit: string = GIBS_CREDIT): ImageryLayer {
  const provider = new C.WebMapTileServiceImageryProvider({
    url: GIBS_DAY_URL,
    layer: "BlueMarble_ShadedRelief_Bathymetry",
    style: "default",
    tileMatrixSetID: "GoogleMapsCompatible_Level8",
    format: "image/jpeg",
    tilingScheme: new C.WebMercatorTilingScheme(),
    maximumLevel: 8,
    credit: new C.Credit(credit, true),
  });
  return new C.ImageryLayer(provider, {});
}

export function nightLayer(
  C: Cesium,
  url: string,
  brightness: number,
  credit: string = BLACK_MARBLE_CREDIT,
): ImageryLayer {
  const layer = C.ImageryLayer.fromProviderAsync(
    C.SingleTileImageryProvider.fromUrl(url, {
      rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90),
      credit: new C.Credit(credit, true),
    }),
    {},
  );
  // Night lights show only on the night side of the terminator.
  layer.dayAlpha = 0;
  layer.nightAlpha = 1;
  layer.brightness = brightness;
  return layer;
}
