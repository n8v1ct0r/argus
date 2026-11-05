import type { Source } from "../events/types.ts";

/** Immutable version id: `{source}:{native id}@{version}`. */
export function versionId(source: Source, nativeId: string, version: string | number): string {
  return `${source}:${nativeId}@${version}`;
}

/** Upstream identity without version: `{source}:{native id}`. */
export function recordKeyOf(source: Source, nativeId: string): string {
  return `${source}:${nativeId}`;
}

/** Matches Argus event ids, used to keep ids out of brief text. */
export const EVENT_ID_PATTERN = /\b(?:usgs|celestrak|eonet|firms|flights|argus):[^\s,;)]+/gi;
