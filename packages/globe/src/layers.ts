// Turns plain LayerData into Cesium primitive collections. One collection per layer,
// rebuilt on setLayer (replay updates at about 1 Hz, so a rebuild is cheap enough and
// keeps the code simple). Every item carries { layerId, id } for picking.
import type {
  BillboardCollection,
  Cartesian3,
  Color,
  GeometryInstance,
  PointPrimitiveCollection,
  PolylineCollection,
  Primitive,
  Scene,
} from "cesium";
import type { Cesium } from "./runtime.ts";
import type { GlobeTheme, LayerData } from "./types.ts";

// Surface events drawn at 0 m fight the ellipsoid for depth; lift them slightly.
const MIN_HEIGHT_M = 1500;

type Handle = PointPrimitiveCollection | BillboardCollection | Primitive | PolylineCollection;

export interface MountedLayer {
  handle: Handle;
  /** id to world position, for highlight rings and flyTo. */
  index: Map<string, Cartesian3>;
}

const colorCache = new Map<string, Color>();
export function cssColor(C: Cesium, css: string): Color {
  let c = colorCache.get(css);
  if (!c) {
    c = C.Color.fromCssColorString(css);
    colorCache.set(css, c);
  }
  return c;
}

function itemColor(C: Cesium, data: LayerData, i: number, fallback: string): Color {
  return cssColor(C, data.colors?.[i] ?? data.color ?? fallback);
}

let chevronCanvas: HTMLCanvasElement | null = null;
/** A north-pointing chevron: white core (tinted per item) inside a dark halo (stays dark). */
function chevronImage(halo: string): HTMLCanvasElement {
  if (chevronCanvas) return chevronCanvas;
  const size = 32;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d canvas unavailable");
  g.beginPath();
  g.moveTo(16, 3);
  g.lineTo(27, 28);
  g.lineTo(16, 21);
  g.lineTo(5, 28);
  g.closePath();
  g.lineJoin = "round";
  g.lineWidth = 4;
  g.strokeStyle = halo;
  g.stroke();
  g.fillStyle = "#ffffff";
  g.fill();
  chevronCanvas = c;
  return c;
}

function pos(C: Cesium, arr: Float64Array, i: number): Cartesian3 {
  const lon = arr[i * 3] ?? 0;
  const lat = arr[i * 3 + 1] ?? 0;
  const h = Math.max(arr[i * 3 + 2] ?? 0, MIN_HEIGHT_M);
  return C.Cartesian3.fromDegrees(lon, lat, h);
}

export function mountLayer(
  C: Cesium,
  scene: Scene,
  layerId: string,
  data: LayerData,
  theme: GlobeTheme,
): MountedLayer {
  const index = new Map<string, Cartesian3>();
  const halo = cssColor(C, theme.halo);

  switch (data.kind) {
    case "points": {
      const coll = new C.PointPrimitiveCollection();
      data.ids.forEach((id, i) => {
        const position = pos(C, data.positions, i);
        index.set(id, position);
        coll.add({
          id: { layerId, id },
          position,
          color: itemColor(C, data, i, "#ffffff"),
          pixelSize: data.pixelSize ?? 4,
          outlineColor: halo,
          outlineWidth: 1,
        });
      });
      scene.primitives.add(coll);
      return { handle: coll, index };
    }
    case "rings": {
      const coll = new C.PointPrimitiveCollection();
      data.ids.forEach((id, i) => {
        const position = pos(C, data.positions, i);
        index.set(id, position);
        coll.add({
          id: { layerId, id },
          position,
          color: C.Color.TRANSPARENT,
          pixelSize: data.diametersPx[i] ?? 8,
          outlineColor: itemColor(C, data, i, "#ffffff"),
          outlineWidth: data.strokePx ?? 1.5,
        });
      });
      scene.primitives.add(coll);
      return { handle: coll, index };
    }
    case "chevrons": {
      const coll = new C.BillboardCollection({ scene });
      const image = chevronImage(theme.halo);
      const size = data.sizePx ?? 14;
      data.ids.forEach((id, i) => {
        const position = pos(C, data.positions, i);
        index.set(id, position);
        coll.add({
          id: { layerId, id },
          position,
          image,
          width: size,
          height: size,
          color: itemColor(C, data, i, "#ffffff"),
          verticalOrigin: C.VerticalOrigin.CENTER,
          alignedAxis: C.Cartesian3.UNIT_Z,
          // Cesium rotates counter-clockwise; compass headings run clockwise.
          rotation: -C.Math.toRadians(data.rotationsDeg[i] ?? 0),
        });
      });
      scene.primitives.add(coll);
      return { handle: coll, index };
    }
    case "areas": {
      const instances: GeometryInstance[] = [];
      data.ids.forEach((id, i) => {
        const w = data.rects[i * 4] ?? 0;
        const s = data.rects[i * 4 + 1] ?? 0;
        const e = data.rects[i * 4 + 2] ?? 0;
        const n = data.rects[i * 4 + 3] ?? 0;
        index.set(id, C.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, MIN_HEIGHT_M));
        instances.push(
          new C.GeometryInstance({
            id: { layerId, id },
            geometry: new C.RectangleGeometry({
              rectangle: C.Rectangle.fromDegrees(w, s, e, n),
              height: MIN_HEIGHT_M,
              vertexFormat: C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
            }),
          }),
        );
      });
      const primitive = new C.Primitive({
        geometryInstances: instances,
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Stripe", {
            evenColor: cssColor(C, data.color ?? "#ffffff"),
            oddColor: C.Color.TRANSPARENT,
            repeat: 6,
          }),
          translucent: true,
        }),
        asynchronous: false,
      });
      scene.primitives.add(primitive);
      return { handle: primitive, index };
    }
    case "paths": {
      const coll = new C.PolylineCollection();
      data.ids.forEach((id, i) => {
        const flat = data.paths[i];
        if (!flat || flat.length < 4) return;
        const positions = C.Cartesian3.fromDegreesArray(Array.from(flat));
        const mid = positions[Math.floor(positions.length / 2)];
        if (mid) index.set(id, mid);
        coll.add({
          id: { layerId, id },
          positions,
          width: data.widthPx ?? 1.5,
          material: C.Material.fromType("Color", { color: itemColor(C, data, i, "#ffffff") }),
        });
      });
      scene.primitives.add(coll);
      return { handle: coll, index };
    }
  }
}

export function unmountLayer(scene: Scene, layer: MountedLayer): void {
  scene.primitives.remove(layer.handle);
}

export function setMountedVisible(layer: MountedLayer, visible: boolean): void {
  layer.handle.show = visible;
}
