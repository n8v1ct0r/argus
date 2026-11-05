// Post-build checks on the emitted client chunks (.next/static), run by `pnpm build`:
// 1. Every chunk parses. Turbopack's minifier once emitted an octal escape inside a template
//    literal that no browser could parse; the build still "succeeded".
// 2. No chunk names the model key variable or contains an Anthropic key prefix
//    (docs/plan.md 7: the key is read only on the server).
//
//   node scripts/check-build.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Script } from "node:vm";

const ROOT = join(import.meta.dirname, "..");
const STATIC_DIR = join(ROOT, ".next", "static");
const FORBIDDEN = ["ANTHROPIC_API_KEY", "sk-ant-"];

function jsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) jsFiles(path, out);
    else if (path.endsWith(".js")) out.push(path);
  }
  return out;
}

let files: string[];
try {
  files = jsFiles(STATIC_DIR);
} catch {
  console.error(`check-build: ${relative(ROOT, STATIC_DIR)} is missing. Run pnpm build first.`);
  process.exit(2);
}

const problems: string[] = [];
for (const file of files) {
  const code = readFileSync(file, "utf8");
  const name = relative(ROOT, file);
  try {
    new Script(code, { filename: name });
  } catch (err) {
    problems.push(`${name}: does not parse (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const needle of FORBIDDEN) {
    if (code.includes(needle)) problems.push(`${name}: contains "${needle}"`);
  }
}

for (const p of problems) console.log(p);
console.log(`check-build: ${problems.length} problems in ${files.length} client chunks.`);
process.exit(problems.length ? 1 : 0);
