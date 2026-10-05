// @vitest-environment node
/**
 * `pwa/src/hooks/useAuth.ts` must never reach `pwa/src/constants.ts` (#266).
 *
 * WHY. `pwa/tests/e2e/helpers/auth-helper.ts` imports `@/hooks/useAuth` (for
 * `USER_ID_KEY` / `namespacedKey`) and runs under plain Node inside Playwright,
 * not Vite. `constants.ts` reads `import.meta.env` at module load, which is
 * undefined there, so once `useAuth.ts` pulls it in — even transitively — every
 * E2E spec fails to load. Vitest, `tsc` and ESLint all run with Vite's
 * `import.meta.env` typings or shims, so none of them notice; this file does.
 * The marker's key and CLEAR live in the import-free `reauthPendingKey.ts` for
 * exactly this reason (see its header).
 *
 * HOW. The import graph is walked statically from the source text with the
 * TypeScript parser: every runtime `import` / `export … from` / `import()` is
 * followed, `import type` / `export type` are skipped (erased at compile time);
 * an inline `import { type X }` is still followed, erring on the safe side.
 * Only `@/…` and relative specifiers are followed — a bare package such as
 * `moo-family-bookshelf-shared/…` lives outside `pwa/src` and cannot import
 * `@/constants`. An unresolvable `@/` or relative specifier throws, so a
 * resolver gap cannot silently drop an edge. The positive controls prove the
 * walker does reach `constants.ts` when it is imported.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import ts from "typescript";

// Resolve from `import.meta.url` as a STRING — Vite rewrites the literal
// `new URL("...", import.meta.url)` form into a served asset URL.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src");
const CONSTANTS = "constants.ts";
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Module specifiers `text` loads at runtime (type-only imports excluded). */
function runtimeSpecifiers(text: string, file: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

/** Absolute path of a `@/` or relative specifier; `null` for a bare package. */
function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve "${spec}" imported by ${from}`);
}

/** Every `pwa/src` file reachable from `entry`, as `src`-relative POSIX paths. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const key = relative(SRC, file).replaceAll("\\", "/");
    if (seen.has(key)) continue;
    seen.add(key);
    if (!/\.tsx?$/u.test(file)) continue;
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"), file)) {
      const target = resolveSpecifier(file, spec);
      if (target !== null) queue.push(target);
    }
  }
  return seen;
}

describe("useAuth import chain", () => {
  it("never reaches constants.ts from hooks/useAuth.ts", () => {
    const reachable = reachableFrom("hooks/useAuth.ts");

    // Positive companion: the walker followed useAuth's real `@/` edges.
    expect(reachable).toContain("utils/reauthPendingKey.ts");
    expect(reachable).toContain("routes.ts");
    expect([...reachable]).not.toContain(CONSTANTS);
  });

  it.each(["utils/reauthPending.ts", "App.tsx"])(
    "positive control: finds constants.ts from %s",
    (entry) => {
      expect(reachableFrom(entry)).toContain(CONSTANTS);
    },
  );

  it("follows every runtime import form and skips type-only ones", () => {
    const text = [
      'import { a } from "@/a";',
      'import "./b";',
      'import {\n  c,\n} from "../c";',
      'export { d } from "@/d";',
      'export * from "@/e";',
      'const f = () => import("@/f");',
      'import { type G } from "@/g";',
      'import type { T } from "@/type-import";',
      'export type { U } from "@/type-export";',
    ].join("\n");

    expect(runtimeSpecifiers(text, "fixture.ts")).toEqual([
      "@/a",
      "./b",
      "../c",
      "@/d",
      "@/e",
      "@/f",
      "@/g",
    ]);
  });

  it("throws on an unresolvable relative or @/ specifier instead of dropping it", () => {
    const from = join(SRC, "hooks/useAuth.ts");

    expect(() => resolveSpecifier(from, "@/no-such-module")).toThrow(
      /cannot resolve/u,
    );
    expect(() => resolveSpecifier(from, "./no-such-module")).toThrow(
      /cannot resolve/u,
    );
    expect(resolveSpecifier(from, "react")).toBeNull();
  });
});
