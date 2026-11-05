// Copy rules check (CLAUDE.md, "Copy rules"): no em or en dashes and none of the banned words in
// user-visible text. Scans string literals, template text, and JSX text in the app and globe code
// (not comments, types, imports, or style attributes), plus README.md, DATA-LICENSES.md, and the
// portfolio kit. Exits 1 on any violation.
//
//   node scripts/check-copy.ts            the default scope
//   node scripts/check-copy.ts FILE...    only these files
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { copyViolations } from "../src/check/copy-rules.ts";

const ROOT = join(import.meta.dirname, "..");

const SOURCE_ROOTS = ["src", "packages/globe/src", "argus.config.ts"];
/** Files that must name the banned words to enforce them. */
const SKIP_SOURCES = ["src/check/"];
const TEXT_FILES = ["README.md", "DATA-LICENSES.md", "portfolio"];
const TEXT_EXTS = new Set([".md", ".mdx", ".txt", ".json"]);

/** JSX attributes whose values a person reads or hears. Every other attribute is code. */
const VISIBLE_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "alt",
  "placeholder",
  "label",
]);

interface Finding {
  file: string;
  line: number;
  detail: string;
}

function walk(path: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(path)) return out;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(join(path, name), keep, out);
    }
  } else if (keep(path)) {
    out.push(path);
  }
  return out;
}

/** True when the literal is code: an import path, a type, a property name, or a non-visible attribute. */
function isCodeLiteral(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) {
    return true;
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  for (let p: ts.Node | undefined = parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isJsxAttribute(p)) return !VISIBLE_ATTRS.has(p.name.getText());
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return false;
  }
  return false;
}

function scanSource(file: string): Finding[] {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  const check = (node: ts.Node, value: string) => {
    for (const v of copyViolations(value)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      findings.push({ file, line, detail: v.detail });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (node.text.trim()) check(node, node.text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isCodeLiteral(node)) check(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      if (!isCodeLiteral(node)) {
        // Each literal part on its own, so a placeholder never joins two words into one.
        check(node.head, node.head.text);
        for (const span of node.templateSpans) check(span.literal, span.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function scanText(file: string): Finding[] {
  const findings: Finding[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const v of copyViolations(line)) findings.push({ file, line: i + 1, detail: v.detail });
    });
  return findings;
}

// Explicit paths (node scripts/check-copy.ts a.tsx b.md) replace the default scope.
const args = process.argv.slice(2);
const isSource = (p: string) => /\.tsx?$/.test(p) && !p.endsWith(".d.ts");
const sources = args.length
  ? args.filter(isSource)
  : SOURCE_ROOTS.flatMap((r) => walk(join(ROOT, r), isSource)).filter(
      (p) => !SKIP_SOURCES.some((s) => relative(ROOT, p).startsWith(s)),
    );
const texts = args.length
  ? args.filter((p) => TEXT_EXTS.has(extname(p)))
  : TEXT_FILES.flatMap((r) => walk(join(ROOT, r), (p) => TEXT_EXTS.has(extname(p))));

const findings = [...sources.flatMap(scanSource), ...texts.flatMap(scanText)];
for (const f of findings) console.log(`${relative(ROOT, f.file)}:${f.line}: ${f.detail}`);
console.log(
  `check-copy: ${findings.length} violations in ${sources.length} source files and ${texts.length} text files.`,
);
process.exit(findings.length ? 1 : 0);
