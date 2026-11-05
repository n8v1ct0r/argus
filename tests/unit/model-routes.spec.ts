// Input validation for the model routes. Every case here is refused before the route opens the
// database or builds a model client, so the test needs neither.
import { expect, test } from "@playwright/test";
import { POST as ask } from "../../src/app/api/ask/route.ts";
import { POST as runBrief } from "../../src/app/api/brief/run/route.ts";
import { copyViolations } from "../../src/check/copy-rules.ts";

const SECRET = "test-scheduler-secret";
let savedSecret: string | undefined;

test.beforeEach(() => {
  savedSecret = process.env.ARGUS_SCHEDULER_SECRET;
});

test.afterEach(() => {
  if (savedSecret === undefined) delete process.env.ARGUS_SCHEDULER_SECRET;
  else process.env.ARGUS_SCHEDULER_SECRET = savedSecret;
});

function post(url: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

async function expectPlainError(res: Response, status: number, pattern: RegExp) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error?: string; answer?: unknown };
  expect(body.error).toMatch(pattern);
  expect(body.error).toMatch(/^[A-Z]/);
  expect(copyViolations(body.error ?? "")).toEqual([]);
  return body;
}

test("POST /api/ask rejects bad input with plain words", async () => {
  const cases: Array<[string, RegExp]> = [
    ["not json", /not JSON/],
    ["[]", /question as text/],
    ['{"question": 42}', /question as text/],
    ['{"q": "hi"}', /question as text/],
    ['{"question": "   "}', /Type a question first/],
    [JSON.stringify({ question: "x".repeat(301) }), /at most 300 characters/],
  ];
  for (const [body, pattern] of cases) {
    const res = await ask(post("/api/ask", body));
    const json = await expectPlainError(res, 400, pattern);
    // The UI reads AskResponse on errors too.
    expect(json.answer).toBeNull();
  }
});

test("POST /api/brief/run needs the scheduler secret", async () => {
  delete process.env.ARGUS_SCHEDULER_SECRET;
  await expectPlainError(
    await runBrief(post("/api/brief/run", "{}", { "x-argus-scheduler": "anything" })),
    401,
    /ARGUS_SCHEDULER_SECRET/,
  );

  process.env.ARGUS_SCHEDULER_SECRET = SECRET;
  await expectPlainError(await runBrief(post("/api/brief/run", "{}")), 401, /missing or wrong/);
  await expectPlainError(
    await runBrief(post("/api/brief/run", "{}", { "x-argus-scheduler": `${SECRET}x` })),
    401,
    /missing or wrong/,
  );
});

test("POST /api/brief/run rejects a bad body or windowEnd", async () => {
  process.env.ARGUS_SCHEDULER_SECRET = SECRET;
  const auth = { "x-argus-scheduler": SECRET };
  const cases: Array<[string, RegExp]> = [
    ["{", /not JSON/],
    ["[1]", /JSON object/],
    ['"text"', /JSON object/],
    ['{"windowEnd": "yesterday"}', /windowEnd field must be/],
    ['{"windowEnd": -5}', /windowEnd field must be/],
    ['{"windowEnd": 1.5}', /windowEnd field must be/],
    [JSON.stringify({ windowEnd: Date.now() + 3_600_000 }), /not in the future/],
  ];
  for (const [body, pattern] of cases) {
    await expectPlainError(await runBrief(post("/api/brief/run", body, auth)), 400, pattern);
  }
});
