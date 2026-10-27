/** Input rules for the PIN / pattern secret-entry widgets, shared so the Extension and the PWA
 *  accept, block and serialize exactly the same way (issue #385). */

/** Shortest PIN the confirm button accepts. */
export const PIN_MIN_LENGTH = 6;

/** Longest PIN the field accepts; a change past it is ignored. */
export const PIN_MAX_LENGTH = 12;

/** Fewest connected dots the pattern confirm button accepts. */
export const PATTERN_MIN_DOTS = 4;

/**
 * Normalizes a raw PIN field value: non-digit characters are stripped silently
 * (`"12a345"` → `"12345"`). Returns `null` when the stripped value is longer than
 * `PIN_MAX_LENGTH` — the caller then ignores the change and keeps its current value.
 */
export function normalizePinInput(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length > PIN_MAX_LENGTH ? null : digits;
}

/**
 * True when a normalized PIN is long enough to submit (`PIN_MIN_LENGTH` digits or more).
 * While false the confirm button is disabled and Enter does nothing.
 */
export function isPinComplete(pin: string): boolean {
  return pin.length >= PIN_MIN_LENGTH;
}

/**
 * True when the drawn pattern connects at least `PATTERN_MIN_DOTS` dots.
 * While false the confirm button is disabled.
 */
export function isPatternComplete(dots: readonly number[]): boolean {
  return dots.length >= PATTERN_MIN_DOTS;
}

/**
 * Serializes the drawn dot indices to the wire format the Worker hashes:
 * comma-joined, no spaces (`[0, 1, 2, 5]` → `"0,1,2,5"`). Must stay byte-identical,
 * or every stored pattern stops matching.
 */
export function serializePattern(dots: readonly number[]): string {
  return dots.join(",");
}

/**
 * Picks the error line a secret-entry widget shows: its own local message
 * (e.g. a setup mismatch) wins over the caller's `external` error, and once the
 * local message clears the external one shows again. Empty string when neither is set.
 */
export function pickSecretEntryError(
  local: string,
  external: string | undefined,
): string {
  return local || external || "";
}
