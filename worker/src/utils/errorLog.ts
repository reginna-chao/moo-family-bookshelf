import { HTTPException } from "hono/http-exception";

/** KV binding operation named by a workerd "KV <op> failed: <status>" message (list failures say GET). */
export type KvLogOp = "GET" | "GET_BULK" | "PUT" | "DELETE";

/** Names an error may be logged under; anything else becomes "Other", a non-Error throw "NonError". */
export type SafeErrorName =
  | "Error"
  | "TypeError"
  | "SyntaxError"
  | "RangeError"
  | "ReferenceError"
  | "EvalError"
  | "URIError"
  | "AggregateError"
  | "DOMException"
  | "HTTPException"
  | "Other"
  | "NonError";

/** What an error log line may carry: never message, stack or cause. */
export interface SafeErrorSummary {
  name: SafeErrorName;
  /** Only when the message starts with "KV <op> failed: <3 digits>". */
  kvOp?: KvLogOp;
  /** The 3-digit status from that same prefix. */
  kvStatus?: number;
  /** Only for a Hono HTTPException (its `.status`). */
  httpStatus?: number;
}

// Built-in names an `err.name` may pass through as; the three synthetic names are never read from it.
const LOGGABLE_ERROR_NAMES: ReadonlySet<string> = new Set<SafeErrorName>([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException",
]);

const KV_FAILURE_PREFIX = /^KV (GET_BULK|GET|PUT|DELETE) failed: (\d{3})(?!\d)/;

function isLoggableName(name: unknown): name is SafeErrorName {
  return typeof name === "string" && LOGGABLE_ERROR_NAMES.has(name);
}

function isKvLogOp(op: string | undefined): op is KvLogOp {
  return op === "GET" || op === "GET_BULK" || op === "PUT" || op === "DELETE";
}

function summarizeError(err: Error): SafeErrorSummary {
  const summary: SafeErrorSummary = {
    name: isLoggableName(err.name) ? err.name : "Other",
  };
  // A non-string message is never matched nor stringified: that would run a caller-controlled toString.
  const message: unknown = err.message;
  if (typeof message !== "string") return summary;
  const match = KV_FAILURE_PREFIX.exec(message);
  const op = match?.[1];
  const status = match?.[2];
  if (isKvLogOp(op) && status !== undefined) {
    summary.kvOp = op;
    summary.kvStatus = Number(status);
  }
  return summary;
}

/**
 * Reduce a caught error to the fields a Worker log line may carry (#357, #480): an
 * allowlisted type name, the KV operation and status of a workerd "KV <op> failed:
 * <status> <statusText>" message, and an HTTPException's status — never the message,
 * stack or cause. Preventive (#480): whether a production KV error message carries
 * the key is UNVERIFIED — workerd's own text carries no key, but the statusText comes
 * from the KV backend. Verified elsewhere: a corrupt-JSON `SyntaxError` from
 * `kv.get(key, "json")` echoes a fragment of the stored value. Never throws: any
 * failure while inspecting `err` (a throwing getter, a Proxy trap) yields "Other".
 */
export function summarizeErrorForLog(err: unknown): SafeErrorSummary {
  try {
    if (err instanceof HTTPException) {
      const status: unknown = err.status;
      return typeof status === "number" && Number.isInteger(status)
        ? { name: "HTTPException", httpStatus: status }
        : { name: "HTTPException" };
    }
    if (!(err instanceof Error)) return { name: "NonError" };
    return summarizeError(err);
  } catch {
    return { name: "Other" };
  }
}
