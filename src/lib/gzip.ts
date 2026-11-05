import { gunzipSync, gzipSync } from "node:zlib";

export function gzipText(text: string): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(text, "utf8"), { level: 6 }));
}

export function gunzipText(bytes: Uint8Array): string {
  return gunzipSync(bytes).toString("utf8");
}
