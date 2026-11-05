"use client";
// Thin React lifecycle wrapper. Load it with next/dynamic { ssr: false } (Cesium needs a DOM).
import { useEffect, useRef, type RefObject } from "react";
import { createGlobe } from "./index.ts";
import type { Globe, GlobeOptions } from "./types.ts";

export interface GlobeViewProps {
  /** Read once on mount. Changing it later does not recreate the globe. */
  options: Omit<GlobeOptions, "creditContainer">;
  /** An element the host keeps visible for Cesium's own credits. */
  creditContainerRef: RefObject<HTMLElement | null>;
  onReady?: (globe: Globe) => void;
  onError?: (error: unknown) => void;
  className?: string;
}

export function GlobeView({
  options,
  creditContainerRef,
  onReady,
  onError,
  className,
}: GlobeViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const initial = useRef({ options, onReady, onError });

  useEffect(() => {
    const host = hostRef.current;
    const credits = creditContainerRef.current;
    if (!host || !credits) return;
    let globe: Globe | null = null;
    let cancelled = false;
    createGlobe(host, { ...initial.current.options, creditContainer: credits })
      .then((g) => {
        if (cancelled) {
          g.destroy();
          return;
        }
        globe = g;
        initial.current.onReady?.(g);
      })
      .catch((err: unknown) => initial.current.onError?.(err));
    return () => {
      cancelled = true;
      globe?.destroy();
    };
  }, [creditContainerRef]);

  return <div ref={hostRef} className={className} />;
}
