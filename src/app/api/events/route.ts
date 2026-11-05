// GET /api/events?ids=a,b : stored event versions for the citation panel (at most 50 ids).
import type { NextRequest } from "next/server";
import { buildEventsPayload } from "../../../api/server/citations.ts";
import { parseIds } from "../../../api/server/params.ts";
import { IMMUTABLE_VERSIONS, json, respond, SOME_MISSING } from "../../../api/server/respond.ts";
import { getDb } from "../../../db/client.ts";

export async function GET(req: NextRequest) {
  return respond(
    () => parseIds(req.nextUrl.searchParams),
    async (ids) => {
      const payload = await buildEventsPayload(await getDb(), { ids });
      return json(payload, payload.missing.length ? SOME_MISSING : IMMUTABLE_VERSIONS);
    },
  );
}
