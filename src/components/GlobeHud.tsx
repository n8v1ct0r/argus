"use client";
// Instruments drawn over the globe: a latitude ladder on the left, a longitude tape along the
// bottom, a crosshair, and a neutral focus frame at the center, where a flight puts the cited
// events. Every reading comes from the camera; the HUD subscribes itself so the rest of the app
// does not re-render while the camera moves.
import type { CameraState, Globe } from "@argus/globe";
import { useEffect, useState } from "react";

const LAT_PX_PER_DEG = 4.2;
const LON_PX_PER_DEG = 3.4;

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function latLabel(v: number): string {
  if (v === 0) return "0";
  return `${Math.abs(v)}${v > 0 ? "N" : "S"}`;
}

function lonLabel(v: number): string {
  const w = wrapLon(v);
  if (w === 0 || Math.abs(w) === 180) return `${Math.abs(w)}`;
  return `${Math.abs(w)}${w > 0 ? "E" : "W"}`;
}

function heightLabel(m: number): string {
  return `${Math.round(m / 1000).toLocaleString("en-US")} km`;
}

function Caret({ dir }: { dir: "left" | "up" }) {
  return (
    <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true" className="fill-scratch">
      {dir === "left" ? <path d="M8 0v8L1 4z" /> : <path d="M0 8h8L4 1z" />}
    </svg>
  );
}

export interface GlobeHudProps {
  globe: Globe | null;
  /** True while a citation is open: the focus frame tightens on the cited events. */
  active: boolean;
  /** The latitude ladder needs room; phones show only the tape and the frame. */
  compact: boolean;
}

export function GlobeHud({ globe, active, compact }: GlobeHudProps) {
  const [cam, setCam] = useState<CameraState | null>(null);
  useEffect(() => {
    if (!globe) return;
    return globe.onCameraChange(setCam);
  }, [globe]);

  const lat = cam?.lat ?? 28;
  const lon = cam?.lon ?? -40;

  const latTicks: number[] = [];
  for (let v = Math.round(lat / 10) * 10 - 40; v <= Math.round(lat / 10) * 10 + 40; v += 10) {
    if (v >= -90 && v <= 90) latTicks.push(v);
  }
  const lonTicks: number[] = [];
  for (let v = Math.round(lon / 15) * 15 - 60; v <= Math.round(lon / 15) * 15 + 60; v += 15) {
    lonTicks.push(v);
  }
  const frame = active ? (compact ? 120 : 168) : compact ? 96 : 132;

  return (
    <div aria-hidden="true" className="argus-hud pointer-events-none absolute inset-0 select-none">
      {/* Crosshair through the center. */}
      <div className="absolute inset-x-0 top-1/2 h-px bg-white/[0.07]" />
      <div className="absolute inset-y-0 left-1/2 w-px bg-white/[0.07]" />

      {/* The focus frame and its north mark. */}
      <div
        className="focus-frame absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ width: frame, height: frame, opacity: active ? 1 : 0.45 }}
      >
        <span className="absolute -top-5 left-1/2 -translate-x-1/2 font-mono text-micro text-scratch/80">
          N
        </span>
        {active && (
          <span className="absolute inset-[38%] rounded-full border border-dashed border-white/35" />
        )}
      </div>

      {/* Latitude ladder. */}
      {!compact && (
        <div className="hud-ladder absolute top-1/2 h-[220px] w-14 -translate-y-1/2 overflow-hidden">
          {latTicks.map((v) => {
            const y = 110 - (v - lat) * LAT_PX_PER_DEG;
            return (
              <div
                key={v}
                className="absolute left-0 flex items-center gap-1.5"
                style={{ top: y - 7 }}
              >
                <span className="w-7 text-right font-mono text-micro text-scratch/75">
                  {latLabel(v)}
                </span>
                <span className="h-px w-2.5 bg-scratch/60" />
              </div>
            );
          })}
          {latTicks.map((v) => (
            <span
              key={`m${v}`}
              className="absolute left-[34px] h-px w-1.5 bg-scratch/30"
              style={{ top: 110 - (v + 5 - lat) * LAT_PX_PER_DEG }}
            />
          ))}
          <span className="absolute top-[106px] left-[48px]">
            <Caret dir="left" />
          </span>
        </div>
      )}

      {/* Longitude tape and the camera readout. */}
      <div className="hud-tape absolute left-1/2 flex -translate-x-1/2 flex-col items-center">
        <div className="relative h-6 w-[260px] overflow-hidden max-[760px]:w-[200px]">
          {lonTicks.map((v) => {
            const x = 130 + (v - lon) * LON_PX_PER_DEG;
            return (
              <div
                key={v}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
                style={{ left: x }}
              >
                <span className="h-2 w-px bg-scratch/60" />
                <span className="font-mono text-micro text-scratch/75">{lonLabel(v)}</span>
              </div>
            );
          })}
        </div>
        <Caret dir="up" />
        <span className="mt-0.5 font-mono text-micro text-scratch">
          {cam
            ? `${Math.abs(cam.lat).toFixed(1)}°${cam.lat >= 0 ? "N" : "S"} ${Math.abs(wrapLon(cam.lon)).toFixed(1)}°${wrapLon(cam.lon) >= 0 ? "E" : "W"} · ${heightLabel(cam.heightMeters)}`
            : "Camera waits for the globe"}
        </span>
      </div>
    </div>
  );
}
