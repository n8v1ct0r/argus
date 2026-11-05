# CLAUDE.md: Argus

Argus is an open-source, real-time view of Earth plus an AI analyst whose every sentence links to the raw events behind it. Product truth: `PRODUCT.md`. Plan and decisions: `docs/plan.md`. Progress: `tasks/todo.md`. The original brief is in `.local/brief.md` (gitignored; read it at session start).

## Phase gates

Six phases: plan, MVP, polish, capture and portfolio kit, publish, deploy. Stop at the end of each phase, report, and wait for Nate's approval. Check `tasks/todo.md` for the current phase before doing anything.

## Hard rules

1. Public, free data only; follow each source's terms (see docs/plan.md, "Data sources").
2. Never build port scanning, vulnerability scanning, camera feeds, or search by aircraft tail number or owner. No tool, route, or URL parameter filters by aircraft identifier.
3. Code computes every number. The model only writes sentences from computed results.
4. Every number in a brief appears in the events it cites. `scripts/check-briefs.ts` enforces this.
5. Source attribution is on screen for every layer. Cesium and imagery credits stay visible, including in screenshots.

## Model calls

Server routes only. Key from `ANTHROPIC_API_KEY`, never sent to the browser. Every model route has a per-IP rate limit, a daily spend cap, and an output cache for identical inputs. Default model `claude-haiku-4-5-20251001`, set in `argus.config.ts`. Ask before using a larger model.

## Copy rules (UI text, README, portfolio kit)

No em dashes or en dashes. None of the banned words in `.local/brief.md`. Every claim carries a number or "[needs a number]"; never invent, round, total, or combine numbers. Short sentences, active voice, plain words, sentence case.

## Action boundaries

- Proceed: edits inside this repo, installs of the listed stack, builds, tests, local runs, screenshot capture.
- Ask first: creating the GitHub repo, any push, any deploy, new API keys, paid services, unlisted dependencies, system tool installs, any git config change.
- Never edit files outside this repo.

## Stealth scan

The term list lives only in `.local/stealth-terms.txt` (gitignored). Never copy a term into any tracked file, commit message, fixture, screenshot, or doc. Before any push, scan tracked files and `git log -p --all` against that list; any match in history means stop and ask Nate.

## Commands

- `pnpm ingest --loop` (or `--once`): poll every source into `data/argus.db`.
- `pnpm dev`: the app on the local store. `pnpm build && pnpm start` for production.
- `DATABASE_URL=file:./data/argus.db node scripts/export-snapshot.ts`: the static deploy's recorded JSON in `public/snapshot` (gitignored), with the DEMO brief checked by rule 4.
- `ARGUS_MODE=snapshot pnpm build`: the static deploy build. A Vercel build is snapshot mode by default.
- Gates: `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm check:copy`, `pnpm check:indexes`, `bash scripts/stealth-scan.sh`, `gitleaks git .`; e2e: `PW_E2E=1 pnpm test:e2e` on a snapshot build.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
