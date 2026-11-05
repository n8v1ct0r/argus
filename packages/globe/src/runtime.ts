// Loads CesiumJS's official prebuilt bundle (public/cesium/Cesium.js) at runtime instead of
// letting the host's bundler compile Cesium's source. Why: Turbopack's production minifier
// (Next 16.3.6) turns an inlined WASM string in Cesium's dependency graph into a template
// literal with an octal escape ("\00"), which is a SyntaxError, so the whole chunk never runs.
// The prebuilt file is already minified by Cesium's own build and parses cleanly. This also
// keeps @argus/globe independent of any bundler. Only `import type` from "cesium" is allowed.
import type * as CesiumNS from "cesium";

export type Cesium = typeof CesiumNS;

let loading: Promise<Cesium> | null = null;

function addStylesheet(href: string): void {
  if (document.querySelector(`link[data-argus-globe="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.argusGlobe = href;
  document.head.appendChild(link);
}

export function loadCesium(baseUrl: string): Promise<Cesium> {
  const w = window as unknown as { Cesium?: Cesium; CESIUM_BASE_URL?: string };
  w.CESIUM_BASE_URL = baseUrl;
  addStylesheet(`${baseUrl}/Widgets/CesiumWidget/CesiumWidget.css`);
  if (w.Cesium) return Promise.resolve(w.Cesium);
  loading ??= new Promise<Cesium>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${baseUrl}/Cesium.js`;
    script.async = true;
    script.onload = () => {
      if (w.Cesium) resolve(w.Cesium);
      else reject(new Error("Cesium.js loaded but window.Cesium is missing"));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error(`Failed to load ${script.src}`));
    };
    document.head.appendChild(script);
  });
  return loading;
}
