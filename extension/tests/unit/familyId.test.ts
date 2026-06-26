import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFamilyId } from "@/storage/familyId";
import { FAMILY_ID_KEY } from "@/constants";

/**
 * `readFamilyId()` reads FAMILY_ID_KEY from storage.sync first (try/catch),
 * falling back to storage.local. The Firefox-critical case is a REJECTED
 * storage.sync.get: it must still fall through to local instead of throwing.
 */
describe("readFamilyId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the value from storage.sync when present", async () => {
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({
      [FAMILY_ID_KEY]: "fam-from-sync",
    } as never);
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      [FAMILY_ID_KEY]: "fam-from-local",
    } as never);

    const result = await readFamilyId();

    expect(result).toBe("fam-from-sync");
    // sync hit short-circuits — local is never consulted
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it("falls back to storage.local when sync has no key", async () => {
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({} as never);
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      [FAMILY_ID_KEY]: "fam-from-local",
    } as never);

    const result = await readFamilyId();

    expect(result).toBe("fam-from-local");
    expect(chrome.storage.local.get).toHaveBeenCalled();
  });

  it("returns null when neither sync nor local has the key", async () => {
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({} as never);
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);

    const result = await readFamilyId();

    expect(result).toBeNull();
  });

  it("falls back to local and returns its value when storage.sync.get REJECTS (Firefox)", async () => {
    // Firefox without a signed-in account / sync disabled: sync.get rejects.
    vi.mocked(chrome.storage.sync.get).mockRejectedValue(
      new Error("sync storage unavailable"),
    );
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      [FAMILY_ID_KEY]: "fam-from-local",
    } as never);

    const result = await readFamilyId();

    expect(result).toBe("fam-from-local");
    expect(chrome.storage.local.get).toHaveBeenCalled();
  });

  it("returns null when storage.sync.get rejects and local also has no key", async () => {
    vi.mocked(chrome.storage.sync.get).mockRejectedValue(
      new Error("sync storage unavailable"),
    );
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);

    const result = await readFamilyId();

    expect(result).toBeNull();
  });

  it("returns null when the stored value is not a string (type guard)", async () => {
    // A non-string in sync must not be returned; fall through to local, which
    // here also holds a non-string → null.
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({
      [FAMILY_ID_KEY]: 12345,
    } as never);
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      [FAMILY_ID_KEY]: { nested: true },
    } as never);

    const result = await readFamilyId();

    expect(result).toBeNull();
  });

  it("falls through to local when sync value is a non-string but local has a valid string", async () => {
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({
      [FAMILY_ID_KEY]: 999,
    } as never);
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      [FAMILY_ID_KEY]: "fam-from-local",
    } as never);

    const result = await readFamilyId();

    expect(result).toBe("fam-from-local");
  });
});
