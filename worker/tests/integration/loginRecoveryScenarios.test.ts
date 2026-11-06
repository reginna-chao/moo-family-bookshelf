import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { inspect } from "node:util";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import {
  createRateLimitBindings,
  rateLimitBindings,
} from "../helpers/rateLimitBindings";
import { listsToken, seedAuthToken } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB, CHARLIE } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  MAX_AUTH_TOKENS_PER_USER,
  VERIFY_MAX_FAILURES,
  type StoredAuthRecord,
  type VerifyRecord,
} from "../../src/kv/schema";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
  VERIFY_STEP_UP_ATTEMPT_MAX,
  VERIFY_STEP_UP_ATTEMPT_SCOPE,
} from "../../src/services/verification";
import { DERIVED_STEP_UP_BUCKET } from "../../src/services/authRecord";
import { hashAuthToken, hashSecret } from "../../src/utils/crypto";

/**
 * Login and account recovery, end to end through the Hono app.
 *
 * The rules these scenarios hold together:
 * - The current-secret step-up has one budget and one lockout per listed unmarked
 *   token. Every other bearer (a `derived` token, one off the list, an account with
 *   no list) shares the one `derived` bucket. Login keeps its own budget and lockout.
 * - A token that proved no secret when minted (QR redeem, TTL-gap refresh) is
 *   `derived`: its QR cannot skip verification, its mint never evicts an unmarked
 *   token, and a mint that proved the secret evicts it before any unmarked token.
 * - A QR redeem that would not fit without evicting an unmarked token is refused
 *   before anything but the spent QR is written.
 * - A rescue link is a `qr:` record only the KV operator writes by hand
 *   (`worker/DEPLOY.md` → 救援連結). It skips the gate and the recovery refusal,
 *   charges nothing and mints an unmarked token. The removed-member and family-full
 *   checks still apply. A dissolved family's 404 does not consume it, and neither does
 *   the 409 for a live membership elsewhere: both answer before the link is looked at.
 *
 * Harness: no DEV_MODE on any request under test, so every budget is really charged;
 * setup goes through DEV_MODE so it spends nothing. Every guess comes from a source
 * address never used before, because `VERIFY_MAX_FAILURES` equals the step-up budget:
 * on one address a 429 could be the lockout instead of the budget, and every 429 here
 * asserts `error.code` to tell them apart. The lockout scenario shares one address on
 * purpose. The binding stubs admit every per-IP charge and count nothing, so a
 * per-minute refusal is asked for through a decider.
 *
 * The operator steps are the documented ones. `runDocumentedNode` runs the `node -e`
 * line of `worker/DEPLOY.md` with test values, in a temp directory it removes again, and
 * the mock KV stores exactly what that line wrote, so the document and the shape the
 * Worker reads cannot drift apart. It runs once per suite: each run spawns a process.
 * `Date` is pinned mid-window, so no budget rolls over by accident, and steps forward
 * between mints, so `createdAt` order is real.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Env = Record<string, unknown>;
type Body = Record<string, unknown>;

let kv: KVNamespace;
let sourceCounter = 0;

const USER_ID = ALICE;
const OWNER_ID = BOB;
const OTHER_ID = CHARLIE;
const FAMILY_ID = "abcd-1234";
const NEW_FAMILY_ID = "wxyz-5678";
const PIN = "123456";
const NEW_PIN = "654321";
const TEMP_PIN = "246813";
const WRONG_PIN = "000000";
const SALT = "ab".repeat(16);
const SECOND_TOKEN = "e".repeat(64);
const RESCUE_TOKEN = "9".repeat(64);
const FRESH_RESCUE_TOKEN = "8".repeat(64);
const SHARED_BOOK_ID = "210439468000101";
const SHARED_IP = "198.51.100.7";
const WINDOW_MS = VERIFY_ATTEMPT_WINDOW_SECONDS * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;
const VERIFY_PATH = `/api/user/${USER_ID}/verify`;

function freshSourceIp(): string {
  sourceCounter += 1;
  return `203.0.${Math.floor(sourceCounter / 250)}.${sourceCounter % 250}`;
}

const prodEnv = (): Env => ({ KV: kv, ...rateLimitBindings() });
const devEnv = (): Env => ({ KV: kv, DEV_MODE: "1" });

async function send(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; ip?: string; env?: Env } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": opts.ip ?? freshSourceIp(),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return app.request(path, init, opts.env ?? prodEnv());
}

/** Each step moves the clock a second, so `createdAt` order is the order of the mints. */
function tick(): void {
  vi.setSystemTime(Date.now() + 1000);
}

async function expectCode(
  res: Response,
  status: number,
  code: string,
): Promise<Json> {
  expect(res.status).toBe(status);
  const { error } = (await res.json()) as Json;
  expect(error.code).toBe(code);
  return error;
}

async function issuedToken(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  tick();
  return ((await res.json()) as Json).data.authToken as string;
}

// --- Account setup -----------------------------------------------------------

/** Set a real PIN through the route (DEV_MODE); returns the unmarked token now current. */
async function setPinAccount(): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const token = await issuedToken(
    await send("PUT", VERIFY_PATH, {
      body: { method: "pin", secret: PIN },
      token: seeded,
      env: devEnv(),
    }),
  );
  return token;
}

/** The second device: a token whose holder proved the PIN, so its entry is unmarked. */
async function addUnmarked(token = SECOND_TOKEN): Promise<string> {
  tick();
  return seedAuthToken(kv, USER_ID, { token, appendTo: true });
}

function addMarked(token: string): Promise<string> {
  tick();
  return seedAuthToken(kv, USER_ID, {
    token,
    appendTo: true,
    derived: BoolFlag.TRUE,
  });
}

/** Add unmarked tokens until the list holds `count`; returns the new tokens. */
async function fillUnmarked(count: number): Promise<string[]> {
  const added: string[] = [];
  for (let i = (await storedAuth()).tokens.length; i < count; i++) {
    added.push(await addUnmarked(String(i).repeat(64)));
  }
  return added;
}

async function seedFamily(
  userIds: string[],
  familyId = FAMILY_ID,
): Promise<void> {
  await Promise.all(userIds.map((uid) => kv.put(kvKeys.member(uid), familyId)));
  await kv.put(
    kvKeys.family(familyId),
    JSON.stringify({
      familyId,
      ownerId: userIds[0],
      members: userIds.map((userId) => ({ userId, displayName: "Member" })),
      maxMembers: 2,
      createdAt: new Date(PINNED_NOW).toISOString(),
    }),
  );
}

async function seedOtherPin(): Promise<void> {
  const record: VerifyRecord = {
    method: "pin",
    hash: await hashSecret(SALT, PIN),
    salt: SALT,
    prompted: BoolFlag.TRUE,
  };
  await kv.put(kvKeys.verify(OTHER_ID), JSON.stringify(record));
}

// --- Requests ----------------------------------------------------------------

function changePin(token: string, currentSecret: string): Promise<Response> {
  return send("PUT", VERIFY_PATH, {
    body: { method: "pin", secret: NEW_PIN, currentSecret },
    token,
  });
}

function wrongStepUp(token: string, ip?: string): Promise<Response> {
  return send("PUT", VERIFY_PATH, {
    body: { method: "none", currentSecret: WRONG_PIN },
    token,
    ip,
  });
}

function join(extra: Body = {}, familyId = FAMILY_ID): Promise<Response> {
  return send("POST", `/api/family/${familyId}/join`, {
    body: { userId: USER_ID, ...extra },
  });
}

function joinWithPin(secret = PIN): Promise<Response> {
  return join({ verifySecret: secret });
}

function readBooks(token: string): Promise<Response> {
  return send("GET", `/api/user/${USER_ID}/books`, { token });
}

async function mintQr(token: string, body: Body = {}): Promise<string> {
  const res = await send("POST", `/api/user/${USER_ID}/qr-token`, {
    body,
    token,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.token as string;
}

/** A device logging in through `token`'s QR, with no secret; asserts it got in. */
async function redeemFrom(token: string): Promise<string> {
  return issuedToken(await join({ qrToken: await mintQr(token) }));
}

async function spendStepUpBudget(token: string): Promise<void> {
  for (let i = 0; i < VERIFY_STEP_UP_ATTEMPT_MAX; i++) {
    await expectCode(await wrongStepUp(token), 403, "VERIFICATION_FAILED");
  }
}

/** Spends login's budget on the lookup gate, which answers even for a dissolved family. */
async function spendLoginBudget(): Promise<void> {
  for (let i = 0; i < VERIFY_ATTEMPT_MAX; i++) {
    await expectCode(
      await send("POST", "/api/auth/lookup", {
        body: { userId: USER_ID, verifySecret: WRONG_PIN },
      }),
      403,
      "VERIFICATION_FAILED",
    );
  }
}

// --- Reading state -----------------------------------------------------------

async function storedAuth(): Promise<StoredAuthRecord> {
  const record = await kv.get<StoredAuthRecord>(kvKeys.auth(USER_ID), "json");
  return record ?? { tokens: [] };
}

async function entryOf(token: string) {
  const hash = await hashAuthToken(token);
  const entry = (await storedAuth()).tokens.find((e) => e.hash === hash);
  expect(entry).toBeDefined();
  return entry!;
}

async function expectUnmarked(token: string): Promise<void> {
  expect(await entryOf(token)).not.toHaveProperty("derived");
}

async function expectDerived(token: string): Promise<void> {
  expect((await entryOf(token)).derived).toBe(BoolFlag.TRUE);
}

async function expectAlive(...tokens: string[]): Promise<void> {
  for (const token of tokens) {
    expect((await readBooks(token)).status).toBe(200);
    expect(await listsToken(kv, USER_ID, token)).toBe(true);
  }
}

async function expectRevoked(...tokens: string[]): Promise<void> {
  for (const token of tokens) {
    expect((await readBooks(token)).status).toBe(401);
    expect(await listsToken(kv, USER_ID, token)).toBe(false);
  }
}

async function stepUpCount(bucket: string): Promise<number | null> {
  const { key } = await peekPerUserRateLimit(kv, {
    userId: `${USER_ID}:${bucket}`,
    scope: VERIFY_STEP_UP_ATTEMPT_SCOPE,
    max: VERIFY_STEP_UP_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  const raw = await kv.get(key);
  return raw === null ? null : parseInt(raw, 10);
}

function stepUpBurstKey(bucket: string): string {
  return `ratelimit:user:verify-stepup-burst:${USER_ID}:${bucket}`;
}

// --- The operator's documented steps ------------------------------------------

const DEPLOY_MD = readFileSync(
  new URL("../../DEPLOY.md", import.meta.url),
  "utf8",
);

/** `worker/DEPLOY.md` → 救援連結, up to the next `## ` heading. */
function rescueSection(): string {
  const start = DEPLOY_MD.indexOf("### 救援連結");
  const end = DEPLOY_MD.indexOf("\n## ", start);
  if (start === -1 || end === -1) throw new Error("救援連結 section not found");
  return DEPLOY_MD.slice(start, end);
}

const RESCUE_LINES = rescueSection().split("\n");
const RESCUE_PUT_LINES = RESCUE_LINES.filter((l) => l.includes("kv key put"));
const REBUILT_AT = new Date(PINNED_NOW).toISOString();

/** The section's `kv key put` for `key`, a `kvKeys` builder fed the documented placeholder. */
function documentedPutLine(key: string): string {
  const line = RESCUE_PUT_LINES.find((l) => l.includes(`put "${key}"`));
  if (!line) throw new Error(`no documented kv key put for ${key}`);
  return line;
}

/** Runs the section's `node -e` writing `tempFile`, with `fill` for its quoted arguments, and returns the file. */
function runDocumentedNode(
  tempFile: string,
  fill: Record<string, string>,
): string {
  const parsed = RESCUE_LINES.find((l) =>
    l.includes(`writeFileSync('${tempFile}'`),
  )?.match(/node -e "([^"]+)"((?: "[^"]+")+)/);
  if (!parsed) throw new Error(`no documented node -e writes ${tempFile}`);
  const args = [...parsed[2].matchAll(/"([^"]+)"/g)].map(([, placeholder]) => {
    if (!(placeholder in fill)) throw new Error(`no value for ${placeholder}`);
    return fill[placeholder];
  });
  const dir = mkdtempSync(joinPath(tmpdir(), "moo-deploy-doc-"));
  try {
    execFileSync(process.execPath, ["-e", parsed[1], ...args], {
      cwd: dir,
      stdio: "pipe",
    });
    return readFileSync(joinPath(dir, tempFile), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let documentedRescueJson: string;
let documentedFamilyJson: string;
let documentedRescueTtl: number;

beforeAll(() => {
  documentedRescueJson = runDocumentedNode("temp-rescue.json", {
    "<userId>": USER_ID,
  });
  documentedFamilyJson = runDocumentedNode("temp-family.json", {
    "<新 familyId>": NEW_FAMILY_ID,
    "<userId>": USER_ID,
    "<暱稱>": "媽媽",
    "<ISO 時間>": REBUILT_AT,
  });
  documentedRescueTtl = Number(
    documentedPutLine(kvKeys.qrToken("<R>")).match(/--ttl (\d+)/)?.[1],
  );
});

function writeRescueRecord(token = RESCUE_TOKEN): Promise<void> {
  return kv.put(kvKeys.qrToken(token), documentedRescueJson, {
    expirationTtl: documentedRescueTtl,
  });
}

/** `worker/DEPLOY.md` → 家庭已解散或換手時: the family record, under the new familyId. */
async function rebuildFamilyAsDocumented(): Promise<void> {
  documentedPutLine(kvKeys.family("<新 familyId>"));
  await kv.put(kvKeys.family(NEW_FAMILY_ID), documentedFamilyJson);
}

/** The same step's deletion, for an old family that is still there. */
async function deleteMemberPointerAsDocumented(): Promise<void> {
  expect(rescueSection()).toContain(
    `kv key delete "${kvKeys.member("<userId>")}"`,
  );
  await kv.delete(kvKeys.member(USER_ID));
}

/** `worker/DEPLOY.md`, temporary PIN steps 3-4: an old-format record, stamped now. */
async function writeTemporaryPin(): Promise<void> {
  const record: VerifyRecord = {
    method: "pin",
    hash: await hashSecret(SALT, TEMP_PIN),
    salt: SALT,
    prompted: BoolFlag.FALSE,
    secretUpdatedAt: Date.now(),
  };
  await kv.put(kvKeys.verify(USER_ID), JSON.stringify(record));
}

/** `worker/DEPLOY.md`, revoke steps 2-4: every hash from the list and the index, token first. */
async function revokeAllByHand(): Promise<void> {
  const indexPrefix = kvKeys.authTokenIndex(USER_ID, "");
  const indexed = (await kv.list({ prefix: indexPrefix })).keys.map((key) =>
    key.name.slice(indexPrefix.length),
  );
  const listed = (await storedAuth()).tokens.map((entry) => entry.hash);
  for (const hash of new Set([...listed, ...indexed])) {
    await kv.delete(kvKeys.authToken(hash));
    await kv.delete(kvKeys.authTokenIndex(USER_ID, hash));
  }
  await kv.delete(kvKeys.auth(USER_ID));
}

/** The whole documented order: temporary PIN, revoke every login, then the link record. */
async function operatorIssuesRescue(): Promise<void> {
  tick();
  await writeTemporaryPin();
  await revokeAllByHand();
  await writeRescueRecord();
}

const rescueJoin = (extra: Body = {}, familyId = FAMILY_ID) =>
  join({ qrToken: RESCUE_TOKEN, ...extra }, familyId);

const rescueRecord = () => kv.get(kvKeys.qrToken(RESCUE_TOKEN));

beforeEach(() => {
  kv = createMockKV();
  sourceCounter = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("step-up budget — one token spends its own", () => {
  it("refuses that token's correct PIN while another token changes the PIN and revokes it", async () => {
    const spent = await setPinAccount();
    const other = await addUnmarked();

    await spendStepUpBudget(spent);
    await expectCode(await changePin(spent, PIN), 429, "RATE_LIMITED");

    const fresh = await issuedToken(await changePin(other, PIN));

    await expectRevoked(spent, other);
    await expectAlive(fresh);
  });

  it("lets the same account's PIN login mint a new token that can change the PIN", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const spent = await setPinAccount();
    await spendStepUpBudget(spent);
    await expectCode(await changePin(spent, PIN), 429, "RATE_LIMITED");

    const relogin = await issuedToken(await joinWithPin());
    await expectUnmarked(relogin);

    const fresh = await issuedToken(await changePin(relogin, PIN));

    await expectRevoked(spent, relogin);
    await expectAlive(fresh);
  });

  it("recovers through a rescue link when the login budget is spent as well", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const spent = await setPinAccount();
    await spendStepUpBudget(spent);
    await spendLoginBudget();
    await expectCode(await joinWithPin(), 429, "RATE_LIMITED");

    await operatorIssuesRescue();
    const rescued = await issuedToken(await rescueJoin());

    await expectRevoked(spent);
    const fresh = await issuedToken(await changePin(rescued, TEMP_PIN));
    await expectAlive(fresh);
  });
});

describe("step-up budget — a device that logged in through a QR", () => {
  it("shares a budget with every other derived token, and may be evicted, while the minting token stays", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const minting = await setPinAccount();
    const phone = await redeemFrom(minting);
    const another = await redeemFrom(minting);

    await spendStepUpBudget(another);
    await expectCode(await changePin(phone, PIN), 429, "RATE_LIMITED");
    expect(await stepUpCount(await hashAuthToken(minting))).toBeNull();

    // The list fills: three more derived mints, the third evicting the oldest derived.
    await redeemFrom(minting);
    await redeemFrom(minting);
    await expectAlive(phone);
    const last = await redeemFrom(minting);

    await expectRevoked(phone);
    await expectAlive(minting, another, last);
    expect((await storedAuth()).tokens).toHaveLength(MAX_AUTH_TOKENS_PER_USER);
  });

  it("gets back in through a new QR from the minting token, and through a rescue link once login is spent", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const minting = await setPinAccount();
    const phone = await redeemFrom(minting);
    for (let i = 0; i < MAX_AUTH_TOKENS_PER_USER - 1; i++) {
      await redeemFrom(minting);
    }
    await expectRevoked(phone);

    const newPhone = await redeemFrom(minting);
    await expectAlive(newPhone);
    await expectDerived(newPhone);

    await spendLoginBudget();
    await expectCode(await joinWithPin(), 429, "RATE_LIMITED");
    await operatorIssuesRescue();
    const rescued = await issuedToken(await rescueJoin());
    await expectAlive(rescued);
    await expectUnmarked(rescued);
  });
});

describe("derived tokens", () => {
  it("spend one shared budget, which leaves the minting token's alone", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const minting = await setPinAccount();
    const first = await redeemFrom(minting);
    const second = await redeemFrom(minting);
    await expectDerived(first);
    await expectDerived(second);

    await spendStepUpBudget(first);

    await expectCode(await changePin(second, PIN), 429, "RATE_LIMITED");
    expect(await stepUpCount(DERIVED_STEP_UP_BUCKET)).toBe(
      VERIFY_STEP_UP_ATTEMPT_MAX,
    );
    expect(await stepUpCount(await hashAuthToken(minting))).toBeNull();
    await expectCode(await wrongStepUp(minting), 403, "VERIFICATION_FAILED");
    expect((await changePin(minting, PIN)).status).toBe(200);
  });

  it("cannot hand out a QR that skips verification, and spends that QR", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const minting = await setPinAccount();
    const derived = await redeemFrom(minting);
    const listBefore = await kv.get(kvKeys.auth(USER_ID));
    const qr = await mintQr(derived);

    await expectCode(await join({ qrToken: qr }), 403, "VERIFICATION_REQUIRED");

    expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER_ID))).toBe(listBefore);
  });

  it("hold the sequential total to one share per bucket: 5 + 5 wrong guesses, then 429", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const minting = await setPinAccount();
    const first = await redeemFrom(minting);
    const second = await redeemFrom(minting);

    let compared = 0;
    for (let i = 0; i < 30; i++) {
      const res = await wrongStepUp([minting, first, second][i % 3]);
      if (res.status === 403) {
        await expectCode(res, 403, "VERIFICATION_FAILED");
        compared += 1;
      } else {
        await expectCode(res, 429, "RATE_LIMITED");
      }
    }

    expect(compared).toBe(VERIFY_STEP_UP_ATTEMPT_MAX * 2);
    expect(await stepUpCount(await hashAuthToken(minting))).toBe(
      VERIFY_STEP_UP_ATTEMPT_MAX,
    );
    expect(await stepUpCount(DERIVED_STEP_UP_BUCKET)).toBe(
      VERIFY_STEP_UP_ATTEMPT_MAX,
    );
  });
});

describe("POST /api/auth/refresh — a TTL gap", () => {
  it.each([
    {
      label: "no auth: record",
      gap: () => kv.delete(kvKeys.auth(USER_ID)),
    },
    {
      label: "an empty list",
      gap: () => kv.put(kvKeys.auth(USER_ID), JSON.stringify({ tokens: [] })),
    },
  ])(
    "marks the token it mints over $label, on the shared budget",
    async ({ gap }) => {
      const before = await setPinAccount();
      await gap();

      const res = await send("POST", "/api/auth/refresh", {
        body: { userId: USER_ID },
        token: before,
      });
      expect(res.status).toBe(200);
      const renewed = ((await res.json()) as Json).data.token as string;

      await expectDerived(renewed);
      const sharing = await addMarked("7".repeat(64));
      await spendStepUpBudget(renewed);
      await expectCode(await changePin(sharing, PIN), 429, "RATE_LIMITED");
      expect(await stepUpCount(DERIVED_STEP_UP_BUCKET)).toBe(
        VERIFY_STEP_UP_ATTEMPT_MAX,
      );
    },
  );

  it("cannot hand out a QR that skips verification", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const before = await setPinAccount();
    await kv.delete(kvKeys.auth(USER_ID));
    const res = await send("POST", "/api/auth/refresh", {
      body: { userId: USER_ID },
      token: before,
    });
    const renewed = ((await res.json()) as Json).data.token as string;

    await expectCode(
      await join({ qrToken: await mintQr(renewed) }),
      403,
      "VERIFICATION_REQUIRED",
    );
  });
});

describe("the token list under repeated QR redeems", () => {
  it("never pushes out an unmarked token", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const minting = await setPinAccount();
    const other = await addUnmarked();

    for (let i = 0; i < MAX_AUTH_TOKENS_PER_USER + 2; i++) {
      await redeemFrom(minting);
    }

    await expectAlive(minting, other);
    await expectUnmarked(minting);
    await expectUnmarked(other);
    const { tokens } = await storedAuth();
    expect(tokens).toHaveLength(MAX_AUTH_TOKENS_PER_USER);
    expect(tokens.filter((e) => e.derived === BoolFlag.TRUE)).toHaveLength(
      MAX_AUTH_TOKENS_PER_USER - 2,
    );
  });

  it.each([
    { label: "a listed member", members: [OWNER_ID, USER_ID] },
    { label: "a new member", members: [OWNER_ID] },
  ])(
    "refuses $label's QR when the list is full of live unmarked tokens, writing only the spent QR",
    async ({ members }) => {
      await seedFamily(members);
      const minting = await setPinAccount();
      const others = await fillUnmarked(MAX_AUTH_TOKENS_PER_USER);
      const qr = await mintQr(minting);
      const before = [
        await kv.get(kvKeys.auth(USER_ID)),
        await kv.get(kvKeys.family(FAMILY_ID)),
      ];
      const ops = watchKvOps(kv);

      await expectCode(
        await join({ qrToken: qr }),
        403,
        "VERIFICATION_REQUIRED",
      );

      expect(ops.writeTrail()).toEqual([`delete ${kvKeys.qrToken(qr)}`]);
      expect([
        await kv.get(kvKeys.auth(USER_ID)),
        await kv.get(kvKeys.family(FAMILY_ID)),
      ]).toEqual(before);
      await expectAlive(minting, ...others);
    },
  );

  it("accepts the QR one token short of a full list", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const minting = await setPinAccount();
    await fillUnmarked(MAX_AUTH_TOKENS_PER_USER - 1);

    const redeemed = await redeemFrom(minting);

    await expectDerived(redeemed);
    expect((await storedAuth()).tokens).toHaveLength(MAX_AUTH_TOKENS_PER_USER);
  });

  it.each([
    {
      label: "whose token: key is gone",
      kill: (hash: string) => kv.delete(kvKeys.authToken(hash)),
    },
    {
      label: "whose token: key names another user",
      kill: (hash: string) =>
        kv.put(
          kvKeys.authToken(hash),
          JSON.stringify({ userId: OTHER_ID, createdAt: "", expiresAt: 0 }),
        ),
    },
  ])(
    "accepts the QR on a full list holding an entry $label, evicting that entry",
    async ({ kill }) => {
      await seedFamily([OWNER_ID, USER_ID]);
      const minting = await setPinAccount();
      const others = await fillUnmarked(MAX_AUTH_TOKENS_PER_USER);
      const dead = others[1];
      await kill(await hashAuthToken(dead));

      const redeemed = await redeemFrom(minting);

      expect(await listsToken(kv, USER_ID, dead)).toBe(false);
      await expectAlive(
        minting,
        redeemed,
        ...others.filter((token) => token !== dead),
      );
    },
  );
});

describe("a mint that proved the secret", () => {
  it("brings a list over the cap back to it", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const first = await setPinAccount();
    const others = await fillUnmarked(MAX_AUTH_TOKENS_PER_USER + 1);

    const relogin = await issuedToken(await joinWithPin());

    expect((await storedAuth()).tokens).toHaveLength(MAX_AUTH_TOKENS_PER_USER);
    // The two oldest go: the first token and the first one added after it.
    await expectRevoked(first, others[0]);
    await expectAlive(relogin, ...others.slice(1));
  });

  it("evicts a derived token before an older unmarked one", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const oldest = await setPinAccount();
    const derived = await addMarked("7".repeat(64));
    const others = await fillUnmarked(MAX_AUTH_TOKENS_PER_USER);

    const relogin = await issuedToken(await joinWithPin());

    await expectRevoked(derived);
    await expectAlive(oldest, relogin, ...others);
  });

  it("evicts the oldest unmarked token once no derived one is left", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const oldest = await setPinAccount();
    const others = await fillUnmarked(MAX_AUTH_TOKENS_PER_USER);

    const relogin = await issuedToken(await joinWithPin());

    await expectRevoked(oldest);
    await expectAlive(relogin, ...others);
  });
});

describe("the derived mark across writes", () => {
  it("survives a later mint's write-back, and adds nothing to an unmarked entry", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const unmarked = await setPinAccount();
    const derived = await redeemFrom(unmarked);

    const relogin = await issuedToken(await joinWithPin());

    await expectDerived(derived);
    await expectUnmarked(unmarked);
    await expectUnmarked(relogin);
  });

  it("survives a refresh of the marked token and keeps it on the shared budget", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const unmarked = await setPinAccount();
    const derived = await redeemFrom(unmarked);
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);

    const res = await send("POST", "/api/auth/refresh", {
      body: { userId: USER_ID },
      token: derived,
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.token).toBe(derived);
    await expectDerived(derived);
    await expectCode(await wrongStepUp(derived), 403, "VERIFICATION_FAILED");
    expect(await stepUpCount(DERIVED_STEP_UP_BUCKET)).toBe(1);
  });

  it("reads an older entry without the field as unmarked: its own budget, and a QR that skips verification", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await setPinAccount();
    const older = await addUnmarked();
    expect(await entryOf(older)).not.toHaveProperty("derived");

    await expectCode(await wrongStepUp(older), 403, "VERIFICATION_FAILED");
    expect(await stepUpCount(await hashAuthToken(older))).toBe(1);
    expect(await stepUpCount(DERIVED_STEP_UP_BUCKET)).toBeNull();
    await expectDerived(await redeemFrom(older));
  });
});

describe("the per-minute limit — one token spends its own", () => {
  it("refuses that token with 60 seconds to wait while another token saves", async () => {
    const limited = await setPinAccount();
    const other = await addUnmarked();
    const refusedKey = stepUpBurstKey(await hashAuthToken(limited));
    const { bindings, calls } = createRateLimitBindings(
      (_name, key) => key !== refusedKey,
    );
    const env = { KV: kv, ...bindings };

    const refused = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token: limited,
      env,
    });
    const error = await expectCode(refused, 429, "RATE_LIMITED");
    expect(error.retryAfter).toBe(60);

    const saved = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token: other,
      env,
    });

    expect(saved.status).toBe(200);
    expect(calls.map((call) => call.key)).toEqual(
      expect.arrayContaining([
        refusedKey,
        stepUpBurstKey(await hashAuthToken(other)),
      ]),
    );
  });

  it("gives derived tokens one limit between them", async () => {
    await setPinAccount();
    const marked = await addMarked("7".repeat(64));
    const otherMarked = await addMarked("8".repeat(64));
    const refusedKey = stepUpBurstKey(DERIVED_STEP_UP_BUCKET);
    const { bindings } = createRateLimitBindings(
      (_name, key) => key !== refusedKey,
    );
    const env = { KV: kv, ...bindings };

    for (const token of [marked, otherMarked]) {
      await expectCode(
        await send("PUT", VERIFY_PATH, {
          body: { method: "none", currentSecret: PIN },
          token,
          env,
        }),
        429,
        "RATE_LIMITED",
      );
    }
  });
});

describe("the lockout — one source address", () => {
  it("locks the token that kept guessing wrong and nothing else from that address", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const locked = await setPinAccount();
    const other = await addUnmarked();

    for (let i = 0; i < VERIFY_MAX_FAILURES; i++) {
      await expectCode(
        await wrongStepUp(locked, SHARED_IP),
        403,
        "VERIFICATION_FAILED",
      );
    }

    const lockedError = await expectCode(
      await send("PUT", VERIFY_PATH, {
        body: { method: "none", currentSecret: PIN },
        token: locked,
        ip: SHARED_IP,
      }),
      429,
      "VERIFICATION_LOCKED",
    );
    expect(lockedError.retryAfter).toBeGreaterThan(0);

    const login = await send("POST", `/api/family/${FAMILY_ID}/join`, {
      body: { userId: USER_ID, verifySecret: PIN },
      ip: SHARED_IP,
    });
    expect(login.status).toBe(200);

    const saved = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token: other,
      ip: SHARED_IP,
    });
    expect(saved.status).toBe(200);

    expect(
      await kv.get(
        kvKeys.verifyFail(
          USER_ID,
          `${SHARED_IP}:${await hashAuthToken(locked)}`,
        ),
      ),
    ).not.toBeNull();
    expect(await kv.get(kvKeys.verifyFail(USER_ID, SHARED_IP))).toBeNull();
  });

  it("answers the same token from another address with its spent budget, not the lockout", async () => {
    const locked = await setPinAccount();
    for (let i = 0; i < VERIFY_MAX_FAILURES; i++) {
      await wrongStepUp(locked, SHARED_IP);
    }

    await expectCode(await changePin(locked, PIN), 429, "RATE_LIMITED");
  });
});

describe("a rescue link", () => {
  beforeEach(async () => {
    await seedFamily([OWNER_ID, USER_ID]);
  });

  it("works exactly once", async () => {
    await setPinAccount();
    await writeRescueRecord();

    const rescued = await issuedToken(await rescueJoin());

    expect(await rescueRecord()).toBeNull();
    await expectAlive(rescued);
    await expectCode(await rescueJoin(), 403, "VERIFICATION_REQUIRED");
  });

  it("neither skips verification nor gets spent for another userId", async () => {
    await setPinAccount();
    await seedOtherPin();
    await writeRescueRecord();

    await expectCode(
      await join({ userId: OTHER_ID, qrToken: RESCUE_TOKEN }),
      403,
      "VERIFICATION_REQUIRED",
    );

    expect(await rescueRecord()).not.toBeNull();
    expect((await rescueJoin()).status).toBe(200);
  });

  it.each<{ label: string; rescue: unknown }>([
    { label: "0", rescue: 0 },
    { label: "2", rescue: 2 },
    { label: "true", rescue: true },
    { label: "the string 1", rescue: "1" },
    { label: "null", rescue: null },
    { label: "absent", rescue: undefined },
  ])("does not skip verification with rescue: $label", async ({ rescue }) => {
    await setPinAccount();
    const before = await kv.get(kvKeys.auth(USER_ID));
    await kv.put(
      kvKeys.qrToken(RESCUE_TOKEN),
      JSON.stringify({ userId: USER_ID, rescue }),
    );

    await expectCode(await rescueJoin(), 403, "VERIFICATION_REQUIRED");

    expect(await rescueRecord()).toBeNull();
    expect(await kv.get(kvKeys.auth(USER_ID))).toBe(before);
  });

  it("stays an ordinary QR with rescue: 0 on a record bound to a listed token", async () => {
    const minting = await setPinAccount();
    await kv.put(
      kvKeys.qrToken(RESCUE_TOKEN),
      JSON.stringify({
        userId: USER_ID,
        tokenHash: await hashAuthToken(minting),
        rescue: 0,
      }),
    );

    await expectDerived(await issuedToken(await rescueJoin()));
  });

  it("is never what POST /qr-token writes, even when the body asks", async () => {
    const minting = await setPinAccount();

    const qr = await mintQr(minting, { rescue: 1, userId: OTHER_ID });

    const record = JSON.parse((await kv.get(kvKeys.qrToken(qr)))!);
    expect(record).toEqual({
      userId: USER_ID,
      tokenHash: await hashAuthToken(minting),
    });
  });

  it("answers MEMBER_REMOVED under a removal record, and is spent", async () => {
    await setPinAccount();
    await writeRescueRecord();
    await kv.put(
      kvKeys.kicked(FAMILY_ID, USER_ID),
      JSON.stringify({ removedAt: PINNED_NOW, removedBy: OWNER_ID }),
    );

    await expectCode(await rescueJoin(), 403, "MEMBER_REMOVED");

    expect(await rescueRecord()).toBeNull();
  });

  it("answers FAMILY_FULL for a family with no seat, and is spent", async () => {
    await setPinAccount();
    await seedFamily([OWNER_ID, OTHER_ID]);
    await kv.delete(kvKeys.member(USER_ID));
    await writeRescueRecord();

    await expectCode(await rescueJoin(), 409, "FAMILY_FULL");

    expect(await rescueRecord()).toBeNull();
  });

  it("admits an unlisted user who sends recovery: 1, where a PIN join with it is refused", async () => {
    await setPinAccount();
    await seedFamily([OWNER_ID]);
    await kv.delete(kvKeys.member(USER_ID));

    await expectCode(
      await join({ verifySecret: PIN, recovery: 1 }),
      409,
      "RECOVERY_NOT_MEMBER",
    );

    await writeRescueRecord();
    expect((await rescueJoin({ recovery: 1 })).status).toBe(200);
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(FAMILY_ID);
  });

  it("reconnects a listed member who sends recovery: 1", async () => {
    await setPinAccount();
    await writeRescueRecord();

    expect((await rescueJoin({ recovery: 1 })).status).toBe(200);
  });

  it("spends no budget and writes no counter, with every limit already spent", async () => {
    await setPinAccount();
    await spendLoginBudget();
    await writeRescueRecord();
    const loginBurstKey = `ratelimit:user:verify-burst:${USER_ID}`;
    const { bindings, calls } = createRateLimitBindings(
      (_name, key) => key !== loginBurstKey,
    );
    const ops = watchKvOps(kv);

    const res = await send("POST", `/api/family/${FAMILY_ID}/join`, {
      body: { userId: USER_ID, qrToken: RESCUE_TOKEN },
      env: { KV: kv, ...bindings },
    });

    expect(res.status).toBe(200);
    const counters = ops
      .writeTrail()
      .filter((entry) => /ratelimit:|verifyfail:/.test(entry));
    expect(counters).toEqual([]);
    expect(ops.writeTrail()).toContain(
      `delete ${kvKeys.qrToken(RESCUE_TOKEN)}`,
    );
    expect(calls.map((call) => call.key)).not.toContain(loginBurstKey);
    // Positive companion: the per-IP charge still reached the stub on this request.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("works from an address the login gate has locked", async () => {
    await setPinAccount();
    for (let i = 0; i < VERIFY_MAX_FAILURES; i++) {
      await send("POST", "/api/auth/lookup", {
        body: { userId: USER_ID, verifySecret: WRONG_PIN },
        ip: SHARED_IP,
      });
    }
    await writeRescueRecord();

    const res = await send("POST", `/api/family/${FAMILY_ID}/join`, {
      body: { userId: USER_ID, qrToken: RESCUE_TOKEN },
      ip: SHARED_IP,
    });

    expect(res.status).toBe(200);
  });

  it("mints an unmarked token that can issue a QR which skips verification", async () => {
    await setPinAccount();
    await writeRescueRecord();

    const rescued = await issuedToken(await rescueJoin());

    await expectUnmarked(rescued);
    await expectDerived(await redeemFrom(rescued));
  });

  it("does not read or need any token of the account", async () => {
    await setPinAccount();
    await revokeAllByHand();
    await writeRescueRecord();
    const ops = watchKvOps(kv);

    const rescued = await issuedToken(await rescueJoin());

    expect(
      ops.getKeys().filter((key) => key.startsWith(kvKeys.authToken(""))),
    ).toEqual([]);
    await expectAlive(rescued);
  });
});

describe("after the operator's revoke", () => {
  beforeEach(async () => {
    await seedFamily([OWNER_ID, USER_ID]);
  });

  it("leaves the old token with no way to read, leave or issue a QR, and the rescued one past the step-up", async () => {
    const old = await setPinAccount();
    const pendingQr = await mintQr(old);
    await operatorIssuesRescue();

    const rescued = await issuedToken(await rescueJoin());

    expect((await readBooks(old)).status).toBe(401);
    const leave = await send(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${USER_ID}`,
      { token: old },
    );
    expect(leave.status).toBe(401);
    const qr = await send("POST", `/api/user/${USER_ID}/qr-token`, {
      body: {},
      token: old,
    });
    expect(qr.status).toBe(401);
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(FAMILY_ID);
    await expectAlive(rescued);

    // A QR the old token issued beforehand no longer skips verification either.
    await expectCode(
      await join({ qrToken: pendingQr }),
      403,
      "VERIFICATION_REQUIRED",
    );

    // Positive companion: the same three requests pass with the rescued token.
    const fresh = await issuedToken(await changePin(rescued, TEMP_PIN));
    await expectAlive(fresh);
    expect((await mintQr(fresh)).length).toBe(64);
  });

  it("refuses the old PIN and takes the temporary one on the rescued token", async () => {
    await setPinAccount();
    await operatorIssuesRescue();
    const rescued = await issuedToken(await rescueJoin());

    await expectCode(await changePin(rescued, PIN), 403, "VERIFICATION_FAILED");
    expect((await changePin(rescued, TEMP_PIN)).status).toBe(200);
  });
});

describe("a rescue link for a family that no longer exists", () => {
  const books = JSON.stringify({
    schemaVersion: 1,
    userId: USER_ID,
    books: [],
  });

  /** A sole owner's own leave dissolves the family and revokes every token. */
  async function dissolve(): Promise<void> {
    await seedFamily([USER_ID]);
    await kv.put(kvKeys.user(USER_ID), books);
    const owner = await setPinAccount();
    const left = await send(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${USER_ID}`,
      { token: owner },
    );
    expect(left.status).toBe(200);
    expect(await kv.get(kvKeys.family(FAMILY_ID))).toBeNull();
    await expectRevoked(owner);
  }

  it("answers 404 for the old familyId without being spent", async () => {
    await dissolve();
    await spendLoginBudget();
    await writeRescueRecord();

    await expectCode(await rescueJoin(), 404, "FAMILY_NOT_FOUND");

    expect(await rescueRecord()).not.toBeNull();
  });

  it("reconnects through a family rebuilt from the documented JSON under a new familyId", async () => {
    await dissolve();
    await spendLoginBudget();
    await writeRescueRecord();
    await expectCode(await rescueJoin(), 404, "FAMILY_NOT_FOUND");
    await rebuildFamilyAsDocumented();
    expect(await kv.get(kvKeys.member(USER_ID))).toBeNull();

    const res = await rescueJoin({}, NEW_FAMILY_ID);

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Json;
    expect(data.familyId).toBe(NEW_FAMILY_ID);
    expect(data.ownerId).toBe(USER_ID);
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(NEW_FAMILY_ID);
    expect(await kv.get(kvKeys.user(USER_ID))).toBe(books);
    await expectUnmarked(data.authToken);
    const members = await send("GET", `/api/family/${NEW_FAMILY_ID}/members`, {
      token: data.authToken,
    });
    expect(members.status).toBe(200);
  });

  it("leaves the old familyId closed to another account, which gets into nothing", async () => {
    await dissolve();
    await writeRescueRecord();
    await rebuildFamilyAsDocumented();
    expect((await rescueJoin({}, NEW_FAMILY_ID)).status).toBe(200);

    await expectCode(
      await join({ userId: OTHER_ID }, FAMILY_ID),
      404,
      "FAMILY_NOT_FOUND",
    );

    expect(await kv.get(kvKeys.family(FAMILY_ID))).toBeNull();
    expect(await kv.get(kvKeys.member(OTHER_ID))).toBeNull();
  });
});

describe("a rescue link when the family changed hands", () => {
  const bookshelfPath = `/api/family/${FAMILY_ID}/bookshelf`;
  const memberPath = (familyId: string) =>
    `/api/family/${familyId}/member/${USER_ID}`;

  /** The account hands its family over through the real route; it stays listed and pointed. */
  async function handOver(): Promise<void> {
    await seedFamily([USER_ID, OWNER_ID]);
    const token = await setPinAccount();
    const res = await send("PUT", `/api/family/${FAMILY_ID}/transfer`, {
      body: { newOwnerId: OWNER_ID },
      token,
    });
    expect(res.status).toBe(200);
    const old = (await kv.get(kvKeys.family(FAMILY_ID), "json")) as Json;
    expect(old.ownerId).toBe(OWNER_ID);
    expect(old.members.map((m: Json) => m.userId)).toContain(USER_ID);
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(FAMILY_ID);
  }

  async function sharedBookIdsOnOldShelf(owner: string): Promise<string[]> {
    const res = await send("GET", bookshelfPath, { token: owner });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Json;
    return data.members.flatMap((m: Json) =>
      m.books.map((b: Json) => b.bookId),
    );
  }

  it("answers 409 unspent while member: names the old family, and 200 once it is deleted as documented", async () => {
    await handOver();
    await operatorIssuesRescue();
    await rebuildFamilyAsDocumented();
    const rebuilt = await kv.get(kvKeys.family(NEW_FAMILY_ID));
    const ops = watchKvOps(kv);

    await expectCode(
      await rescueJoin({}, NEW_FAMILY_ID),
      409,
      "ALREADY_IN_FAMILY",
    );

    expect(ops.writeTrail()).toEqual([]);
    expect(await rescueRecord()).not.toBeNull();
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(FAMILY_ID);
    expect(await kv.get(kvKeys.family(NEW_FAMILY_ID))).toBe(rebuilt);
    expect(await kv.get(kvKeys.auth(USER_ID))).toBeNull();

    await deleteMemberPointerAsDocumented();
    const res = await rescueJoin({}, NEW_FAMILY_ID);

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Json;
    expect(data.familyId).toBe(NEW_FAMILY_ID);
    expect(data.ownerId).toBe(USER_ID);
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(NEW_FAMILY_ID);
    expect(await rescueRecord()).toBeNull();
    await expectUnmarked(data.authToken);
    const members = await send("GET", `/api/family/${NEW_FAMILY_ID}/members`, {
      token: data.authToken,
    });
    expect(members.status).toBe(200);
  });

  it("takes the books off the old shelf, leaves the old record alone, and is out of the old owner's reach", async () => {
    await handOver();
    const books = JSON.stringify({
      schemaVersion: 1,
      userId: USER_ID,
      books: [{ bookId: SHARED_BOOK_ID, title: "T", isShared: BoolFlag.TRUE }],
    });
    await kv.put(kvKeys.user(USER_ID), books);
    const owner = await seedAuthToken(kv, OWNER_ID);
    expect(await sharedBookIdsOnOldShelf(owner)).toContain(SHARED_BOOK_ID);
    const oldRecord = await kv.get(kvKeys.family(FAMILY_ID));
    await operatorIssuesRescue();
    await rebuildFamilyAsDocumented();
    await deleteMemberPointerAsDocumented();

    const rescued = await issuedToken(await rescueJoin({}, NEW_FAMILY_ID));

    expect(await sharedBookIdsOnOldShelf(owner)).not.toContain(SHARED_BOOK_ID);
    expect(await kv.get(kvKeys.family(FAMILY_ID))).toBe(oldRecord);
    expect(await kv.get(kvKeys.user(USER_ID))).toBe(books);

    // Removing them from the old family touches neither the rebuilt family nor the session.
    const rebuilt = await kv.get(kvKeys.family(NEW_FAMILY_ID));
    await expectCode(
      await send("DELETE", memberPath(NEW_FAMILY_ID), { token: owner }),
      403,
      "NOT_OWNER",
    );
    const kick = await send("DELETE", memberPath(FAMILY_ID), { token: owner });
    expect(kick.status).toBe(200);
    expect(await kv.get(kvKeys.kicked(FAMILY_ID, USER_ID))).not.toBeNull();
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(NEW_FAMILY_ID);
    expect(await kv.get(kvKeys.family(NEW_FAMILY_ID))).toBe(rebuilt);
    await expectAlive(rescued);
  });

  it("gets a kicked account in through the rebuilt family with a fresh link", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    const kicked = await setPinAccount();
    const owner = await seedAuthToken(kv, OWNER_ID);
    const kick = await send("DELETE", memberPath(FAMILY_ID), { token: owner });
    expect(kick.status).toBe(200);
    await expectRevoked(kicked);
    await operatorIssuesRescue();

    await expectCode(await rescueJoin(), 403, "MEMBER_REMOVED");
    expect(await rescueRecord()).toBeNull();

    await rebuildFamilyAsDocumented();
    await expectCode(
      await rescueJoin({}, NEW_FAMILY_ID),
      403,
      "VERIFICATION_REQUIRED",
    );

    await writeRescueRecord(FRESH_RESCUE_TOKEN);
    const res = await join({ qrToken: FRESH_RESCUE_TOKEN }, NEW_FAMILY_ID);

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Json;
    expect(data.familyId).toBe(NEW_FAMILY_ID);
    expect(data.ownerId).toBe(USER_ID);
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(NEW_FAMILY_ID);
    expect(await kv.get(kvKeys.kicked(FAMILY_ID, USER_ID))).not.toBeNull();
    await expectUnmarked(data.authToken);
    await expectAlive(data.authToken);
  });
});

describe("worker/DEPLOY.md", () => {
  it("documents a command writing the rescue record the Worker recognises", () => {
    expect(JSON.parse(documentedRescueJson)).toEqual({
      userId: USER_ID,
      rescue: BoolFlag.TRUE,
    });
    expect(documentedPutLine(kvKeys.qrToken("<R>"))).toContain(
      "--path temp-rescue.json",
    );
  });

  it("documents a one-hour TTL on the rescue record", () => {
    expect(documentedRescueTtl).toBe(3600);
  });

  it("documents a command writing the family record the Worker reads, stored with no TTL", () => {
    expect(JSON.parse(documentedFamilyJson)).toEqual({
      familyId: NEW_FAMILY_ID,
      ownerId: USER_ID,
      members: [
        { userId: USER_ID, displayName: "媽媽", canLend: BoolFlag.TRUE },
      ],
      maxMembers: 2,
      createdAt: REBUILT_AT,
    });
    const put = documentedPutLine(kvKeys.family("<新 familyId>"));
    expect(put).toContain("--path temp-family.json");
    expect(put).not.toContain("--ttl");
  });

  it("inlines no single-quoted JSON in any kv key put of the rescue section", () => {
    expect(RESCUE_PUT_LINES).toHaveLength(2);
    for (const line of RESCUE_PUT_LINES) {
      expect(line).toContain("--path temp-");
      expect(line).not.toContain("'");
    }
  });

  it("names the code the member: deletion clears", () => {
    expect(rescueSection()).toContain("ALREADY_IN_FAMILY");
  });

  it("documents the link format", () => {
    expect(rescueSection()).toContain(
      "<PWA 網址>/#code=<同步碼>&uid=<userId>&qrt=<R>",
    );
  });
});

describe("a KV failure inside the step-up", () => {
  /** Reject `op` on keys under `prefix` with an error whose message names the key. */
  function failKv(op: "get" | "put", prefix: string): string[] {
    const thrown: string[] = [];
    const real = (kv[op] as (...args: unknown[]) => Promise<unknown>).bind(kv);
    vi.spyOn(kv, op).mockImplementation(((...args: unknown[]) => {
      const key = String(args[0]);
      if (key.startsWith(prefix)) {
        const message = `KV ${op} failed for ${key}`;
        thrown.push(message);
        return Promise.reject(new Error(message));
      }
      return real(...args);
    }) as never);
    return thrown;
  }

  function captureLogs() {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    return {
      errors: () => spies[2].mock.calls,
      text: () =>
        inspect(
          spies.flatMap((spy) => spy.mock.calls),
          { depth: 6 },
        ),
    };
  }

  it.each<{ op: "get" | "put"; prefix: string }>([
    { op: "get", prefix: "ratelimit:user:verify-stepup:" },
    { op: "put", prefix: "ratelimit:user:verify-stepup:" },
    { op: "get", prefix: "verifyfail:" },
    { op: "put", prefix: "verifyfail:" },
  ])(
    "answers 500 on $op of $prefix and logs no token hash",
    async ({ op, prefix }) => {
      const token = await setPinAccount();
      const hash = await hashAuthToken(token);
      const thrown = failKv(op, prefix);
      const logs = captureLogs();

      const res = await wrongStepUp(token);

      await expectCode(res, 500, "INTERNAL_ERROR");
      // Positive companions: the injected error names the hash, and the failure was logged.
      expect(thrown.length).toBeGreaterThan(0);
      expect(thrown[0]).toContain(hash);
      expect(logs.errors().map((call) => call[0])).toContain(
        "VERIFY_STEP_UP_FAILED",
      );
      expect(logs.text()).not.toContain(hash);
      for (const call of logs.errors()) {
        for (const arg of call) expect(inspect(arg)).not.toContain(hash);
      }
    },
  );
});
