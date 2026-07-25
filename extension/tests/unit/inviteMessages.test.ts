import { describe, it, expect } from "vitest";
import {
  buildSyncCodeInviteMessage,
  buildLinkInviteMessage,
} from "moo-family-bookshelf-shared/invite/messages";

// The invite-message builders are pure shared functions consumed by both the
// Extension and PWA family-settings copy buttons. Tested here alongside the
// other shared pure functions (see reportLinks.test.ts, saveStrategy.test.ts).

describe("buildSyncCodeInviteMessage", () => {
  const SYNC_CODE = "moo-abcd-1234";

  it("interpolates the sync code into the message", () => {
    expect(buildSyncCodeInviteMessage(SYNC_CODE)).toContain(SYNC_CODE);
  });

  it("includes the welcome line and the desktop join instructions", () => {
    const msg = buildSyncCodeInviteMessage(SYNC_CODE);
    expect(msg).toContain("邀請你一起用「墨家書櫃」分享藏書");
    expect(msg).toContain("加入方式（電腦版瀏覽器）");
    expect(msg).toContain("貼上上方同步碼即可加入");
  });

  it("is pure: same input yields identical output", () => {
    expect(buildSyncCodeInviteMessage(SYNC_CODE)).toBe(
      buildSyncCodeInviteMessage(SYNC_CODE),
    );
  });

  it.each(["moo-abcd-1234", "moo-ef01-5678@https://my.worker.dev"])(
    "interpolates the variant sync code %s",
    (code) => {
      expect(buildSyncCodeInviteMessage(code)).toContain(code);
    },
  );
});

describe("buildLinkInviteMessage", () => {
  const INVITE_URL = "https://example.com/#invite=moo-abcd-1234";

  it("interpolates the invite URL into the message", () => {
    expect(buildLinkInviteMessage(INVITE_URL)).toContain(INVITE_URL);
  });

  it("includes the welcome line, link instruction, and the PWA sync reminder", () => {
    const msg = buildLinkInviteMessage(INVITE_URL);
    expect(msg).toContain("邀請你一起用「墨家書櫃」分享藏書");
    expect(msg).toContain("點開這個連結即可加入");
    expect(msg).toContain("小提醒");
    expect(msg).toContain("手機版無法讀取你的讀墨藏書");
  });

  it("is pure: same input yields identical output", () => {
    expect(buildLinkInviteMessage(INVITE_URL)).toBe(
      buildLinkInviteMessage(INVITE_URL),
    );
  });

  it.each([
    "https://example.com/#invite=moo-abcd-1234",
    "https://pwa.example.org/app#invite=moo-ef01-5678%40https%3A%2F%2Fmy.worker.dev",
  ])("interpolates the variant invite URL %s", (url) => {
    expect(buildLinkInviteMessage(url)).toContain(url);
  });
});
