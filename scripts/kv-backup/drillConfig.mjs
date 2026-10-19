import { readFile } from "node:fs/promises";
import { BackupError } from "./format.mjs";

const HEADER = /^(\[\[?)\s*([A-Za-z0-9_.-]+)\s*(\]\]?)$/;
// `key = "basic"` (escapes kept verbatim) or `key = 'literal'` (no escapes, no `'`).
const STRING_ASSIGNMENT =
  /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/;
const HEX_ID = /^[0-9a-f]{32}$/;

// Drops a `#` comment unless it sits inside a double- or single-quoted string.
function stripComment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote === '"' && char === "\\") index++;
    else if (char === quote) quote = "";
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === "#") return line.slice(0, index);
  }
  return line;
}

// `error` is built at the call site so every BackupError message stays a literal.
function requireHexId(value, error) {
  if (!HEX_ID.test(value)) throw error;
  return value;
}

// Collects `key = "value"` / `key = 'value'` per table: "" = top level, "[vars]", "[[r2_buckets]]#0" …
// An unrecognised `[` header switches to "[?]", so its keys match no lookup.
function scanStrings(text) {
  const values = new Map();
  const arrayCounts = new Map();
  let table = "";
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = HEADER.exec(line);
    if (header && (header[1] === "[[") === (header[3] === "]]")) {
      const name = header[2];
      if (header[1] === "[[") {
        const index = arrayCounts.get(name) ?? 0;
        arrayCounts.set(name, index + 1);
        table = `[[${name}]]#${index}`;
      } else {
        table = `[${name}]`;
      }
      continue;
    }
    if (line.startsWith("[")) {
      table = "[?]";
      continue;
    }
    const assignment = STRING_ASSIGNMENT.exec(line);
    if (!assignment) continue;
    const key = `${table} ${assignment[1]}`;
    if (!values.has(key)) values.set(key, assignment[2] ?? assignment[3]);
  }
  return values;
}

/**
 * Reads the four drill settings out of `worker/wrangler.backup.local.toml`
 * text: top-level `account_id`, `[vars].SOURCE_NAMESPACE_ID`,
 * `[vars].RESTORE_DRILL_NAMESPACE_ID` and the first `[[r2_buckets]]`
 * `bucket_name`. A section-aware line scanner, not a TOML parser: only
 * single-line double-quoted or single-quoted (literal) string assignments are
 * read. The three ids must be 32 lowercase hex chars, each with its own error. Pure.
 */
export function parseBackupLocalConfig(text) {
  const values = scanStrings(typeof text === "string" ? text : "");
  const accountId = values.get(" account_id");
  if (accountId === undefined)
    throw new BackupError(
      "worker/wrangler.backup.local.toml 缺少頂層 account_id，請依 worker/DEPLOY.md「KV 每日備份與還原演練」第 3 節補上。",
    );
  const sourceNamespaceId = values.get("[vars] SOURCE_NAMESPACE_ID");
  if (sourceNamespaceId === undefined)
    throw new BackupError(
      "worker/wrangler.backup.local.toml 缺少 [vars] 的 SOURCE_NAMESPACE_ID，請依 worker/DEPLOY.md「KV 每日備份與還原演練」第 3 節補上。",
    );
  const drillNamespaceId = values.get("[vars] RESTORE_DRILL_NAMESPACE_ID");
  if (drillNamespaceId === undefined)
    throw new BackupError(
      "worker/wrangler.backup.local.toml 缺少 [vars] 的 RESTORE_DRILL_NAMESPACE_ID，請依 worker/DEPLOY.md「KV 每日備份與還原演練」第 3 節補上。",
    );
  const bucket = values.get("[[r2_buckets]]#0 bucket_name");
  if (bucket === undefined)
    throw new BackupError(
      "worker/wrangler.backup.local.toml 缺少 [[r2_buckets]] 的 bucket_name，請依 worker/DEPLOY.md「KV 每日備份與還原演練」第 3 節補上。",
    );
  return {
    ...requireDrillIds({ accountId, sourceNamespaceId, drillNamespaceId }),
    bucket,
  };
}

// One error per field, so a name or template placeholder points at its own line.
function requireDrillIds({ accountId, sourceNamespaceId, drillNamespaceId }) {
  return {
    accountId: requireHexId(
      accountId,
      new BackupError(
        "worker/wrangler.backup.local.toml 的頂層 account_id 必須是 32 位小寫十六進位 ID（不是名稱或範本佔位值）。",
      ),
    ),
    sourceNamespaceId: requireHexId(
      sourceNamespaceId,
      new BackupError(
        "worker/wrangler.backup.local.toml 的 [vars] SOURCE_NAMESPACE_ID 必須是 32 位小寫十六進位 ID（不是名稱或範本佔位值）。",
      ),
    ),
    drillNamespaceId: requireHexId(
      drillNamespaceId,
      new BackupError(
        "worker/wrangler.backup.local.toml 的 [vars] RESTORE_DRILL_NAMESPACE_ID 必須是 32 位小寫十六進位 ID（不是名稱或範本佔位值）。",
      ),
    ),
  };
}

/** Reads and parses the local backup config; a missing or unreadable file is one literal error. */
export async function readDrillConfig(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new BackupError(
      "找不到 worker/wrangler.backup.local.toml，請依 worker/DEPLOY.md「KV 每日備份與還原演練」第 3 節建立並填好設定。",
    );
  }
  return parseBackupLocalConfig(text);
}
