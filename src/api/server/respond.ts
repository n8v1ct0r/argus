// JSON responses for the read API routes. Errors are { error: "<plain words>" } with a status
// that matches: 400 for input the route cannot use, 500 when the store cannot answer.
import type { Parsed } from "./params.ts";

export const NO_STORE = "no-store";
/** Layers and the replay: recent windows change as sources report. */
export const RECENT_DATA = "public, max-age=60, s-maxage=300";
/** Fire cells: FIRMS files are rebuilt hourly. */
export const FIRE_DATA = "public, max-age=60, s-maxage=3600";
/** Found event versions never change after insert. */
export const IMMUTABLE_VERSIONS = "public, max-age=300, s-maxage=3600";
/** Missing ids may be written by the next ingest run. */
export const SOME_MISSING = "public, max-age=60";

export const SERVER_ERROR =
  "Argus could not read its event store. Try again in a minute; if it keeps failing, check the server log.";

export function json(payload: unknown, cacheControl: string, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": cacheControl } });
}

export function badRequest(error: string): Response {
  return json({ error }, NO_STORE, 400);
}

/**
 * Runs a route: parses its input, then builds the response. Bad input answers 400 with the
 * parser's words; anything thrown while building answers 500 and is logged on the server.
 */
export async function respond<T>(
  parse: () => Parsed<T>,
  build: (input: T) => Promise<Response>,
): Promise<Response> {
  let input: Parsed<T>;
  try {
    input = parse();
  } catch (err) {
    console.error("[api] could not read the request", err);
    return json({ error: SERVER_ERROR }, NO_STORE, 500);
  }
  if (!input.ok) return badRequest(input.error);
  try {
    return await build(input.value);
  } catch (err) {
    console.error("[api] could not build the response", err);
    return json({ error: SERVER_ERROR }, NO_STORE, 500);
  }
}
