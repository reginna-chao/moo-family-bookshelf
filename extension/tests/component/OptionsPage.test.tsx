import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { READMOO_STORE_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmooStore";
import { OptionsPage } from "@/options/OptionsPage";
import {
  STORE_CHIP_DENIED_MESSAGE,
  STORE_CHIP_REVOKED_MESSAGE,
} from "@/options/storePageChipMessages";
import {
  FAMILY_ID_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  USER_ID_KEY,
} from "@/constants";

/**
 * The extension's options page (#313, src/options/): one switch for the Readmoo store-page chip.
 *
 * Turning it on calls `permissions.request` for the store book-page pattern — synchronously inside the
 * click, because browsers only show the prompt inside a user gesture — and saves `BoolFlag.TRUE` only
 * once granted; a refusal keeps it off and says so. The granted state comes from
 * `permissions.contains` only (never the background's storage mirror), so a switch left on after the
 * permission was taken back in the browser's settings shows the revoked message. The page follows the
 * same switch written by the Dialog (`storage.onChanged`) and re-checks the permission on
 * `permissions.onAdded` / `onRemoved`.
 *
 * Copy: the description and freshness hint are module-private constants in OptionsPage.tsx, so their
 * literals are pinned here against that render site; the denial and revoked messages are imported from
 * storePageChipMessages.ts, the module both screens render them from. Storage runs against the
 * store-backed mock in tests/setup.ts, cleared around every case.
 */

const LABEL = "在讀墨購買頁顯示家人已開放的書";
const DESCRIPTION =
  "開啟後，瀏覽讀墨書籍頁面時，書名下方會顯示哪位家人已開放這本書。需要授權擴充功能讀取 readmoo.com 的書籍頁面";
const FRESHNESS = "顯示的名字在每次打開家庭書櫃時更新";
const NEEDS_FAMILY = "需要先加入家庭";

type Listener = (...args: unknown[]) => void;

function grant(on: boolean): void {
  vi.mocked(browser.permissions.contains).mockResolvedValue(on);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderSettled() {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(<OptionsPage />);
  });
  await settle();
  return utils;
}

function storeSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: LABEL });
}

function lastListener(addListener: unknown): Listener {
  const calls = vi.mocked(addListener as (fn: Listener) => void).mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.local.clear();
  grant(false);
  vi.mocked(browser.permissions.request).mockResolvedValue(false);
});

afterEach(async () => {
  await chrome.storage.local.clear();
});

describe("OptionsPage", () => {
  it("renders the switch off, with its description and freshness hint", async () => {
    await chrome.storage.local.set({ [FAMILY_ID_KEY]: "fam-1" });
    await renderSettled();

    expect(
      screen.getByRole("heading", { name: "墨家書櫃 設定" }),
    ).toBeVisible();
    expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(screen.getByText(FRESHNESS)).toBeInTheDocument();
    const status = screen.getByText("尚未授權");
    expect(status).toHaveClass("moo-options__status");
    expect(status).not.toHaveClass("moo-options__status--granted");
    expect(status.querySelector("svg")).toBeNull();
    expect(screen.queryByText("已授權")).not.toBeInTheDocument();
    expect(screen.queryByText(NEEDS_FAMILY)).not.toBeInTheDocument();
  });

  it("says a family is needed when this device has none", async () => {
    await chrome.storage.local.set({ [USER_ID_KEY]: "u1" });
    await renderSettled();

    expect(screen.getByText(NEEDS_FAMILY)).toBeInTheDocument();
  });

  it("shows the stored switch and the granted permission", async () => {
    grant(true);
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });
    await renderSettled();

    expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
    const status = screen.getByText("已授權");
    expect(status.tagName).toBe("SPAN");
    expect(status).toHaveClass(
      "moo-options__status",
      "moo-options__status--granted",
    );
    // The check icon is decorative; the text alone carries the state.
    expect(status.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(status).toHaveTextContent(/^已授權$/);
    expect(screen.queryByText("尚未授權")).not.toBeInTheDocument();
    expect(
      screen.queryByText(STORE_CHIP_REVOKED_MESSAGE),
    ).not.toBeInTheDocument();
    expect(browser.permissions.contains).toHaveBeenCalledWith({
      origins: [...READMOO_STORE_MATCH_PATTERNS],
    });
  });

  it("asks for the permission inside the click and saves TRUE once granted", async () => {
    vi.mocked(browser.permissions.request).mockResolvedValue(true);
    await renderSettled();

    fireEvent.click(storeSwitch());
    // Synchronous: a prompt outside the user gesture is refused by the browser.
    expect(browser.permissions.request).toHaveBeenCalledWith({
      origins: [...READMOO_STORE_MATCH_PATTERNS],
    });
    await settle();

    expect(
      (await chrome.storage.local.get(STORE_PAGE_CHIP_ENABLED_KEY))[
        STORE_PAGE_CHIP_ENABLED_KEY
      ],
    ).toBe(BoolFlag.TRUE);
    expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("已授權")).toBeInTheDocument();
    expect(
      screen.queryByText(STORE_CHIP_DENIED_MESSAGE),
    ).not.toBeInTheDocument();
  });

  it.each<[string, () => void]>([
    [
      "refused",
      () => vi.mocked(browser.permissions.request).mockResolvedValue(false),
    ],
    [
      "fails",
      () =>
        vi
          .mocked(browser.permissions.request)
          .mockRejectedValue(new Error("not in a user gesture")),
    ],
  ])(
    "stays off and explains when the permission prompt is %s",
    async (_n, setUp) => {
      setUp();
      await renderSettled();

      fireEvent.click(storeSwitch());
      await settle();

      expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith({
        [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      });
      expect(STORE_CHIP_DENIED_MESSAGE).toBe(
        "沒有授權，購買頁就不會顯示家人的名字",
      );
      expect(screen.getByText(STORE_CHIP_DENIED_MESSAGE)).toHaveClass(
        "moo-settings__error-text",
      );
    },
  );

  it("turns off without asking for anything", async () => {
    grant(true);
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });
    await renderSettled();

    fireEvent.click(storeSwitch());
    await settle();

    expect(browser.permissions.request).not.toHaveBeenCalled();
    expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
    expect(
      (await chrome.storage.local.get(STORE_PAGE_CHIP_ENABLED_KEY))[
        STORE_PAGE_CHIP_ENABLED_KEY
      ],
    ).toBe(BoolFlag.FALSE);
  });

  it("says the permission was taken back when the switch is on without it", async () => {
    grant(false);
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });
    await renderSettled();

    expect(STORE_CHIP_REVOKED_MESSAGE).toBe("授權已被收回，請關閉後再開啟一次");
    expect(screen.getByText(STORE_CHIP_REVOKED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText("尚未授權")).toBeInTheDocument();
  });

  it("re-checks the permission when it is granted elsewhere", async () => {
    grant(false);
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });
    await renderSettled();
    expect(screen.getByText(STORE_CHIP_REVOKED_MESSAGE)).toBeInTheDocument();

    grant(true);
    await act(async () => {
      lastListener(browser.permissions.onAdded.addListener)();
    });
    await settle();

    expect(screen.getByText("已授權")).toBeInTheDocument();
    expect(
      screen.queryByText(STORE_CHIP_REVOKED_MESSAGE),
    ).not.toBeInTheDocument();
  });

  it("follows the switch when the Dialog changes it", async () => {
    await renderSettled();

    await act(async () => {
      lastListener(browser.storage.onChanged.addListener)(
        { [STORE_PAGE_CHIP_ENABLED_KEY]: { newValue: BoolFlag.TRUE } },
        "local",
      );
    });

    expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("removes every listener it added on unmount", async () => {
    const { unmount } = await renderSettled();
    const onStorage = lastListener(browser.storage.onChanged.addListener);
    const onAdded = lastListener(browser.permissions.onAdded.addListener);
    const onRemoved = lastListener(browser.permissions.onRemoved.addListener);

    unmount();

    expect(browser.storage.onChanged.removeListener).toHaveBeenCalledWith(
      onStorage,
    );
    expect(browser.permissions.onAdded.removeListener).toHaveBeenCalledWith(
      onAdded,
    );
    expect(browser.permissions.onRemoved.removeListener).toHaveBeenCalledWith(
      onRemoved,
    );
  });
});
