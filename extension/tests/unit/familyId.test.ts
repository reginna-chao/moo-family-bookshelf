import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFamilyId, readSyncFamilyIdRemnant } from "@/storage/familyId";
import { FAMILY_ID_KEY, USER_ID_KEY } from "@/constants";

/**
 * `readFamilyId()` is LOCAL-FIRST: storage.local is authoritative. storage.sync
 * is only a cross-device bootstrap HINT, consulted EXCLUSIVELY when this device
 * has never onboarded (no local USER_ID_KEY). Once onboarded, a missing local
 * familyId means "no family" — a stale sync remnant must NOT resurrect it (the
 * Firefox "zombie familyId" bug).
 *
 * `readSyncFamilyIdRemnant()` exposes that zombie value ON PURPOSE — but only to
 * PRE-FILL the onboarding sync-code input — for an onboarded device that lost
 * its local familyId while sync still holds one.
 *
 * Helpers below let each case declare exactly what each storage area returns,
 * keyed so the type-guard and precedence rules are unambiguous.
 */
function mockLocal(value: Record<string, unknown>): void {
  vi.mocked(chrome.storage.local.get).mockResolvedValue(value as never);
}
function mockSync(value: Record<string, unknown>): void {
  vi.mocked(chrome.storage.sync.get).mockResolvedValue(value as never);
}

describe("readFamilyId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the local familyId and never consults sync when local has it", async () => {
    mockLocal({ [FAMILY_ID_KEY]: "fam-local", [USER_ID_KEY]: "u1" });
    // Even if sync holds a DIFFERENT value, local wins.
    mockSync({ [FAMILY_ID_KEY]: "fam-sync" });

    const result = await readFamilyId();

    expect(result).toBe("fam-local");
    // Local hit short-circuits — sync must not be read.
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it("returns null (never resurrects sync) when onboarded device has userId but no local familyId", async () => {
    // The zombie-familyId case: local userId present (device onboarded), no
    // local familyId, but a stale familyId lingers in sync. Must return null.
    mockLocal({ [USER_ID_KEY]: "u1" });
    mockSync({ [FAMILY_ID_KEY]: "fam-zombie" });

    const result = await readFamilyId();

    expect(result).toBeNull();
    // Authoritative "no family" — sync must NOT be consulted at all.
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it("bootstraps from sync when the device has NEVER onboarded (no local userId)", async () => {
    mockLocal({});
    mockSync({ [FAMILY_ID_KEY]: "fam-bootstrap" });

    const result = await readFamilyId();

    expect(result).toBe("fam-bootstrap");
    expect(chrome.storage.sync.get).toHaveBeenCalled();
  });

  it("returns null when never onboarded and sync also has no familyId", async () => {
    mockLocal({});
    mockSync({});

    const result = await readFamilyId();

    expect(result).toBeNull();
  });

  it("falls back gracefully (null) when never onboarded and sync.get REJECTS (Firefox)", async () => {
    mockLocal({});
    vi.mocked(chrome.storage.sync.get).mockRejectedValue(
      new Error("sync storage unavailable"),
    );

    const result = await readFamilyId();

    expect(result).toBeNull();
  });

  it("ignores a non-string local familyId and treats a present userId as authoritative no-family", async () => {
    // Non-string local familyId fails the type guard; because local userId is
    // present, the device is onboarded → null, sync never consulted.
    mockLocal({ [FAMILY_ID_KEY]: 12345, [USER_ID_KEY]: "u1" });
    mockSync({ [FAMILY_ID_KEY]: "fam-sync" });

    const result = await readFamilyId();

    expect(result).toBeNull();
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it("returns null when never onboarded and the sync value is not a string", async () => {
    mockLocal({});
    mockSync({ [FAMILY_ID_KEY]: { nested: true } });

    const result = await readFamilyId();

    expect(result).toBeNull();
  });
});

describe("readSyncFamilyIdRemnant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the sync familyId when onboarded, no local familyId, and sync holds a remnant", async () => {
    mockLocal({ [USER_ID_KEY]: "u1" });
    mockSync({ [FAMILY_ID_KEY]: "fam-remnant" });

    const result = await readSyncFamilyIdRemnant();

    expect(result).toBe("fam-remnant");
  });

  it("returns null when the device has never onboarded (no local userId)", async () => {
    mockLocal({});
    mockSync({ [FAMILY_ID_KEY]: "fam-remnant" });

    const result = await readSyncFamilyIdRemnant();

    expect(result).toBeNull();
    // No point consulting sync when the device never onboarded.
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it("returns null when a local familyId is present (no remnant to recover)", async () => {
    mockLocal({ [USER_ID_KEY]: "u1", [FAMILY_ID_KEY]: "fam-local" });
    mockSync({ [FAMILY_ID_KEY]: "fam-remnant" });

    const result = await readSyncFamilyIdRemnant();

    expect(result).toBeNull();
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it("returns null when onboarded but sync holds no familyId", async () => {
    mockLocal({ [USER_ID_KEY]: "u1" });
    mockSync({});

    const result = await readSyncFamilyIdRemnant();

    expect(result).toBeNull();
  });

  it("returns null when sync.get REJECTS (Firefox without sync)", async () => {
    mockLocal({ [USER_ID_KEY]: "u1" });
    vi.mocked(chrome.storage.sync.get).mockRejectedValue(
      new Error("sync storage unavailable"),
    );

    const result = await readSyncFamilyIdRemnant();

    expect(result).toBeNull();
  });

  it("returns null when the sync remnant is not a string", async () => {
    mockLocal({ [USER_ID_KEY]: "u1" });
    mockSync({ [FAMILY_ID_KEY]: 999 });

    const result = await readSyncFamilyIdRemnant();

    expect(result).toBeNull();
  });
});
