// Detector modules may contain no numeric literal other than 0, 1, or 360 (docs/plan.md 3):
// thresholds come from argus.config.ts and conversion factors from src/detectors/units.ts.
// The TypeScript parser does the stripping: comments and string text never become
// NumericLiteral nodes, while numbers inside template expressions still do.
import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DETECTORS_DIR = fileURLToPath(new URL("../../src/detectors/", import.meta.url));
const EXEMPT = new Set(["units.ts", "types.ts"]);
const ALLOWED = new Set([0, 1, 360]);

function forbiddenLiterals(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const numeric = ts.isNumericLiteral(node) && !ALLOWED.has(Number(node.text));
    if (numeric || ts.isBigIntLiteral(node)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      found.push(`${fileName}:${line + 1} ${node.getText(file)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test("the literal scan ignores comments and strings but sees template expressions", () => {
  const sample = [
    "// 7 in a line comment",
    "/* 11 in a block comment */",
    'const a = "9 in a string";',
    "const b = `12 in template text ${2}`;",
    "const c = 360 - 1 + 0;",
    "const d = 0.5 + 1e3 + 5;",
  ].join("\n");
  expect(forbiddenLiterals(sample, "sample.ts")).toEqual([
    "sample.ts:4 2",
    "sample.ts:6 0.5",
    "sample.ts:6 1e3",
    "sample.ts:6 5",
  ]);
});

test("detector modules contain no numeric literal other than 0, 1, or 360", () => {
  const files = readdirSync(DETECTORS_DIR)
    .filter((f) => f.endsWith(".ts") && !EXEMPT.has(f))
    .sort();
  expect(files).toEqual(
    expect.arrayContaining(["circling.ts", "fire-growth.ts", "fire-mask.ts", "quake-cluster.ts"]),
  );
  const offenders = files.flatMap((f) =>
    forbiddenLiterals(readFileSync(`${DETECTORS_DIR}${f}`, "utf8"), f),
  );
  expect(offenders).toEqual([]);
});
