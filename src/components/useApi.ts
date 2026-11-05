"use client";
import { useCallback, useEffect, useState } from "react";
import { snapshotGet } from "../snapshot/client.ts";
import { SNAPSHOT_MODE } from "../snapshot/mode.ts";

export interface ApiState<T> {
  /** The latest data, kept while a newer request loads so layers do not flicker. */
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

interface Result<T> {
  key: string | null;
  data: T | null;
  error: string | null;
}

/** GETs JSON from an API route. A null url means "not yet" (no request). */
export function useApi<T>(url: string | null): ApiState<T> {
  const [nonce, setNonce] = useState(0);
  const key = url === null ? null : `${url}#${nonce}`;
  const [result, setResult] = useState<Result<T>>({ key: null, data: null, error: null });

  useEffect(() => {
    if (key === null || url === null) return;
    const ctrl = new AbortController();
    if (SNAPSHOT_MODE) {
      // The static deploy answers from the recorded files instead of the API routes.
      snapshotGet(url)
        .then((body) => {
          if (!ctrl.signal.aborted) setResult({ key, data: body as T, error: null });
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          setResult((prev) => ({
            key,
            data: prev.data,
            error: err instanceof Error ? err.message : String(err),
          }));
        });
      return () => ctrl.abort();
    }
    fetch(url, { signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
        if (ctrl.signal.aborted) return;
        if (!res.ok) {
          setResult((prev) => ({
            key,
            data: prev.data,
            error: body?.error ?? `The server answered ${res.status}.`,
          }));
          return;
        }
        setResult({ key, data: body, error: null });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setResult((prev) => ({
          key,
          data: prev.data,
          error: err instanceof Error ? err.message : String(err),
        }));
      });
    return () => ctrl.abort();
  }, [key, url]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return {
    data: result.data,
    error: result.key === key ? result.error : null,
    loading: key !== null && result.key !== key,
    reload,
  };
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    mq.addEventListener("change", update);
    // Read the current value through the same callback path as later changes.
    queueMicrotask(update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}
