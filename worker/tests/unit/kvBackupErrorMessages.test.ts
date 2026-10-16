import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every BackupError the backup Worker can throw carries a string-literal message.
 *
 * WHY. `scheduled()` in `worker/src/backup/index.ts` logs a BackupError's
 * `message` verbatim to the Worker logs. That is safe only while each message
 * is a repo-authored constant: a template literal, a concatenation or a variable
 * could carry a KV key name (a userId / familyId) or remote error text into
 * them. This grep pins that premise for every file under `worker/src/backup/`
 * (enumerated, so a new file is covered automatically) plus
 * `scripts/kv-backup/format.mjs`, which the Worker imports. The other
 * `scripts/kv-backup/*.mjs` modules (cli, restore, api, storage) are
 * CLI-only, never bundled into the Worker, and deliberately out of scope.
 *
 * THE DETECTOR. A construction is allowed only when its sole argument is one
 * double-quoted literal (optionally on the next line, optionally with a trailing
 * comma). The lookahead is anchored right after `(` so `\s*` cannot backtrack
 * into a false match. A synthetic-input case pins the detector itself, so the
 * negative scan cannot pass vacuously and no production file is ever mutated.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(HERE, "../../src/backup");
const SOURCES = [
  ...readdirSync(BACKUP_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(BACKUP_DIR, name)),
  resolve(HERE, "../../../scripts/kv-backup/format.mjs"),
].map((path) => ({ path, source: readFileSync(path, "utf8") }));

const NON_LITERAL = /new BackupError\((?!\s*"(?:[^"\\\n]|\\.)*"\s*,?\s*\))/;

function hasNonLiteralBackupError(source: string): boolean {
  return NON_LITERAL.test(source);
}

describe("BackupError messages reachable from the backup Worker", () => {
  it("scans more than one source, at least one constructing BackupError", () => {
    expect(SOURCES.length).toBeGreaterThan(1);
    expect(SOURCES.some((s) => s.source.includes("new BackupError("))).toBe(
      true,
    );
  });

  it.each([
    ["throw new BackupError(`x ${k}`)", true],
    ['throw new BackupError("x" + k)', true],
    ["throw new BackupError(message)", true],
    ['throw new BackupError("x")', false],
    ['throw new BackupError("a \\"q\\" b")', false],
    ['new BackupError(\n  "x",\n)', false],
  ])("flags %j as non-literal: %s", (source, expected) => {
    expect(hasNonLiteralBackupError(source)).toBe(expected);
  });

  it("constructs every BackupError from a single string literal", () => {
    const offenders = SOURCES.filter((s) => hasNonLiteralBackupError(s.source));
    expect(offenders.map((s) => s.path)).toEqual([]);
  });
});
