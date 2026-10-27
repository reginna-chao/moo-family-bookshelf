import { expect } from "vitest";

// Web Storage check for the #396 current-secret flows; see expectSecretNotStored's JSDoc.

/** Every key and value in localStorage and sessionStorage, joined for a substring check. */
function storageDump(): string {
  const parts: string[] = [];
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i) ?? "";
      parts.push(key, store.getItem(key) ?? "");
    }
  }
  return parts.join("\n");
}

/**
 * Assert no Web Storage entry carries `secret`: a PIN / pattern entered for a step-up lives in
 * component state only (#396). A sentinel is written and read back first, so a dump that silently
 * reads nothing cannot make the negative assertion pass vacuously.
 */
export function expectSecretNotStored(secret: string) {
  const sentinel = "moo:test-storage-sentinel";
  sessionStorage.setItem(sentinel, "sentinel-value");
  expect(storageDump()).toContain("sentinel-value");
  sessionStorage.removeItem(sentinel);
  expect(storageDump()).not.toContain(secret);
}
