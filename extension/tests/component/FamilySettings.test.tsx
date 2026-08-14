import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { FamilySettings, FamilySettingsProps } from "@/dialog/FamilySettings";
import { FamilyDataProvider } from "@/dialog/FamilyDataContext";
import { validateEndpointUrl, type ApiClient } from "@/api/client";
import {
  API_ENDPOINT_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
  DISPLAY_NAME_KEY,
} from "@/constants";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn().mockResolvedValue({ data: { ok: true } }),
    removeMember: vi.fn().mockResolvedValue({ data: { ok: true } }),
    transferOwnership: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getPersonalBooks: vi.fn(),
    updatePersonalBooks: vi.fn(),
    updateDisplayName: vi.fn().mockResolvedValue({
      data: { userId: "user-abc12345", displayName: "" },
    }),
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-123",
        ownerId: "user-abc12345",
        members: [
          { userId: "user-abc12345", displayName: "小明" },
          { userId: "user-def67890", displayName: "" },
        ],
        maxMembers: 6,
        createdAt: "2026-01-01",
      },
    }),
    getFamilyBookshelf: vi
      .fn()
      .mockResolvedValue({ data: { familyId: "fam-123", members: [] } }),
    deleteAccount: vi.fn().mockResolvedValue({ data: { ok: true } }),
    // Default endpoint + a family record with no apiEndpoint = nothing to
    // confirm, so useEndpointSwitch stays silent and the endpoint-switch panel
    // does not render into tests that are about something else. Tests that
    // exercise the panel override this pair explicitly (see "family endpoint
    // switch confirmation").
    getEndpoint: vi.fn().mockReturnValue(DEFAULT_API_ENDPOINT),
    setEndpoint: vi.fn(),
    updateFamilyEndpoint: vi
      .fn()
      .mockResolvedValue({ data: { familyId: "fam-123", apiEndpoint: null } }),
    getVerifyMethod: vi
      .fn()
      .mockResolvedValue({ data: { method: "none", prompted: 0 } }),
    setVerifyMethod: vi.fn().mockResolvedValue({ data: { ok: true } }),
    generateOtp: vi.fn().mockResolvedValue({
      data: { code: "123456", expiresAt: Date.now() + 300000 },
    }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderFamilySettings(props: Partial<FamilySettingsProps> = {}) {
  const defaultProps: FamilySettingsProps = {
    familyId: "fam-123",
    userId: "user-abc12345",
    apiClient: createMockApiClient(),
    onLeave: vi.fn(),
  };
  const merged = { ...defaultProps, ...props };
  return render(
    <FamilyDataProvider
      familyId={merged.familyId}
      userId={merged.userId}
      apiClient={merged.apiClient}
    >
      <FamilySettings {...merged} />
    </FamilyDataProvider>,
  );
}

/**
 * Stub `chrome.storage.local.get` so every read resolves with the display name
 * plus whatever `extra` entries the test needs (e.g. a recorded endpoint-switch
 * refusal). Returning the same record for any key set is enough here: callers
 * pick the keys they asked for out of it.
 */
function mockStorageGet(extra: Record<string, unknown> = {}) {
  vi.mocked(chrome.storage.local.get).mockImplementation(
    (_keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
      const result = { [DISPLAY_NAME_KEY]: "小明", ...extra };
      if (typeof callback === "function") {
        callback(result);
      }
      return Promise.resolve(result) as unknown as void;
    },
  );
}

describe("FamilySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Return an encryption key and display name from storage
    mockStorageGet();
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.mocked(chrome.storage.sync.set).mockResolvedValue();
  });

  // Helper: find the display name section by its label
  function getDisplayNameSection() {
    return screen.getByText("顯示名稱").closest("div")!.parentElement!;
  }

  function enterEditMode() {
    const section = getDisplayNameSection();
    const pencilBtn = section.querySelector("button")!;
    fireEvent.click(pencilBtn);
  }

  it("shows display name section with loaded value in display mode", async () => {
    renderFamilySettings();

    expect(screen.getByText("顯示名稱")).toBeInTheDocument();
    expect(
      screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
    ).toBeInTheDocument();

    // New inline edit: display mode shows text, not input
    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });
    // No input visible in display mode
    expect(
      screen.queryByPlaceholderText("輸入顯示名稱"),
    ).not.toBeInTheDocument();
  });

  it("enters edit mode when pencil icon is clicked", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });

    enterEditMode();

    // Now input should be visible
    expect(screen.getByPlaceholderText("輸入顯示名稱")).toBeInTheDocument();
  });

  it("exits edit mode and reverts on cancel", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });

    enterEditMode();

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), {
      target: { value: "大明" },
    });

    // Click cancel (X) button — second button in the edit row
    const editButtons = screen
      .getByPlaceholderText("輸入顯示名稱")
      .parentElement!.querySelectorAll("button");
    fireEvent.click(editButtons[1]); // X button

    // Should be back in display mode
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("輸入顯示名稱"),
      ).not.toBeInTheDocument();
    });
  });

  it("saves display name via API and to local/sync storage", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });

    enterEditMode();

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), {
      target: { value: "大明" },
    });

    // Click check (confirm) button — first button in the edit row
    const editButtons = screen
      .getByPlaceholderText("輸入顯示名稱")
      .parentElement!.querySelectorAll("button");
    fireEvent.click(editButtons[0]); // Check button

    await waitFor(() => {
      expect(apiClient.updateDisplayName).toHaveBeenCalledWith(
        "fam-123",
        "user-abc12345",
        "大明",
      );
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [DISPLAY_NAME_KEY]: "大明",
      });
      expect(chrome.storage.sync.set).toHaveBeenCalledWith({
        [DISPLAY_NAME_KEY]: "大明",
      });
    });
  });

  it("shows API displayName for all members in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      // Owner has displayName "小明" from API — appears in both display name editor and member list
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
      // Other member has empty displayName, falls back to userId slice
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });
  });

  it("shows sync code section", async () => {
    renderFamilySettings();

    expect(screen.getByText("家庭同步碼")).toBeInTheDocument();
    // Wait for sync code to load
    await waitFor(() => {
      expect(screen.getByText(/moo-fam-123/)).toBeInTheDocument();
    });
  });

  it("shows copy sync code button", async () => {
    renderFamilySettings();

    expect(screen.getByText("複製同步碼")).toBeInTheDocument();

    // Wait for async member fetch to complete to avoid act() warning.
    // "小明" appears in both the display-name editor and the member list, so
    // use getAllByText.
    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("invite button copies URL with #invite= format containing sync code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderFamilySettings();

    // Wait for members to load so async effects settle.
    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByText("邀請成員加入家庭"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("#invite="),
      );
    });

    // The invite URL should contain the encoded sync code
    const calledWith = writeText.mock.calls[0][0] as string;
    expect(calledWith).toContain("#invite=");
  });

  it("shows member list after loading", async () => {
    renderFamilySettings();

    // Wait for member loading to complete
    await waitFor(() => {
      // "小明" appears in both display name editor and member list
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });

    // The current user should have a "(你)" indicator
    expect(screen.getByText("(你)")).toBeInTheDocument();
  });

  it("shows leave family button", async () => {
    renderFamilySettings();

    expect(screen.getByText("離開家庭")).toBeInTheDocument();

    // Wait for async member fetch to complete to avoid act() warning.
    // "小明" appears in both the display-name editor and the member list.
    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("two-step confirmation: clicking leave shows confirm and cancel", async () => {
    renderFamilySettings();

    // Click the leave button
    fireEvent.click(screen.getByText("離開家庭"));

    // Should now show the confirmation dialog
    await waitFor(() => {
      expect(screen.getByText("確定要離開嗎？")).toBeInTheDocument();
      expect(screen.getByText("確定離開")).toBeInTheDocument();
      expect(screen.getByText("取消")).toBeInTheDocument();
    });

    // Original button should be gone
    expect(screen.queryByText("離開家庭")).not.toBeInTheDocument();
  });

  it("cancel button returns to idle leave state", async () => {
    renderFamilySettings();

    // Enter confirming state
    fireEvent.click(screen.getByText("離開家庭"));

    await waitFor(() => {
      expect(screen.getByText("取消")).toBeInTheDocument();
    });

    // Click cancel
    fireEvent.click(screen.getByText("取消"));

    // Should return to idle state with the leave button visible again
    await waitFor(() => {
      expect(screen.getByText("離開家庭")).toBeInTheDocument();
      expect(screen.queryByText("確定離開")).not.toBeInTheDocument();
    });
  });

  it("shows (管理員) badge next to the owner in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("(管理員)")).toBeInTheDocument();
    });
  });

  it("owner sees remove and transfer buttons for other members", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });
  });

  it("non-owner does not see remove or transfer buttons", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-123",
          ownerId: "user-def67890",
          members: [
            { userId: "user-abc12345", displayName: "小明" },
            { userId: "user-def67890", displayName: "大明" },
          ],
          maxMembers: 6,
          createdAt: "2026-01-01",
        },
      }),
    });

    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("大明")).toBeInTheDocument();
    });

    expect(screen.queryByText("移除")).not.toBeInTheDocument();
    expect(screen.queryByText("轉移管理權")).not.toBeInTheDocument();
  });

  it("shows confirmation when clicking remove button", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定要移除此成員？")).toBeInTheDocument();
      expect(screen.getByText("確定")).toBeInTheDocument();
    });
  });

  it("calls removeMember API and refreshes on confirm", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    const callsBefore = vi.mocked(apiClient.getFamilyMembers).mock.calls.length;

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(apiClient.removeMember).toHaveBeenCalledWith(
        "fam-123",
        "user-def67890",
      );
    });

    // fetchMembers should be called at least once more after the action
    await waitFor(() => {
      expect(
        vi.mocked(apiClient.getFamilyMembers).mock.calls.length,
      ).toBeGreaterThan(callsBefore);
    });
  });

  it("shows confirmation when clicking transfer button", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("轉移管理權"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("確定")).toBeInTheDocument();
    });
  });

  it("calls transferOwnership API and refreshes on confirm", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("轉移管理權"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    const callsBefore = vi.mocked(apiClient.getFamilyMembers).mock.calls.length;

    await waitFor(() => {
      expect(apiClient.transferOwnership).toHaveBeenCalledWith(
        "fam-123",
        "user-abc12345",
        "user-def67890",
        undefined,
      );
    });

    await waitFor(() => {
      expect(
        vi.mocked(apiClient.getFamilyMembers).mock.calls.length,
      ).toBeGreaterThan(callsBefore);
    });
  });

  it("shows owner-specific error when owner tries to leave", async () => {
    const apiClient = createMockApiClient({
      leaveFamily: vi.fn().mockResolvedValue({
        error: { code: "OWNER_CANNOT_LEAVE", message: "Owner cannot leave" },
      }),
    });
    renderFamilySettings({ apiClient });

    fireEvent.click(screen.getByText("離開家庭"));

    await waitFor(() => {
      expect(screen.getByText("確定離開")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定離開"));

    await waitFor(() => {
      expect(
        screen.getByText("管理者必須先轉移管理權才能離開家庭"),
      ).toBeInTheDocument();
    });
  });

  it("cancel confirmation hides confirm dialog in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定要移除此成員？")).toBeInTheDocument();
    });

    // Find the cancel button inside the MemberList confirmation (not the leave cancel)
    const cancelButtons = screen.getAllByText("取消");
    fireEvent.click(cancelButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("確定要移除此成員？")).not.toBeInTheDocument();
    });
  });

  it("shows error when removeMember API fails", async () => {
    const apiClient = createMockApiClient({
      removeMember: vi.fn().mockResolvedValue({
        error: { code: "FORBIDDEN", message: "權限不足" },
      }),
    });
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(screen.getByText("權限不足")).toBeInTheDocument();
    });
  });

  it("shows error when updateDisplayName API fails", async () => {
    const apiClient = createMockApiClient({
      updateDisplayName: vi.fn().mockResolvedValue({
        error: { code: "VALIDATION_ERROR", message: "名稱過長" },
      }),
    });
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });

    enterEditMode();

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), {
      target: { value: "新名稱" },
    });

    // Click check (confirm) button
    const editButtons = screen
      .getByPlaceholderText("輸入顯示名稱")
      .parentElement!.querySelectorAll("button");
    fireEvent.click(editButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("名稱過長")).toBeInTheDocument();
    });
    // Should stay in edit mode after error
    expect(screen.getByPlaceholderText("輸入顯示名稱")).toBeInTheDocument();
  });

  describe("sync archived toggle", () => {
    it("shows '同步封存書籍' toggle switch", async () => {
      renderFamilySettings();

      await waitFor(() => {
        expect(
          screen.getByRole("switch", { name: "同步封存書籍" }),
        ).toBeInTheDocument();
      });
    });

    it("shows description text for the toggle", async () => {
      renderFamilySettings();

      await waitFor(() => {
        expect(
          screen.getByText("啟用後，同步時會一併讀取已封存的書籍"),
        ).toBeInTheDocument();
      });
    });

    it("toggle is initially off (aria-checked false)", async () => {
      // Default sendMessage does not call back, so syncArchived stays 0
      renderFamilySettings();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
      });
    });

    it("toggle reflects initial GET_SYNC_ARCHIVED value of 1", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED") {
            return Promise.resolve({ syncArchived: 1 });
          }
          return Promise.resolve(undefined);
        },
      );

      renderFamilySettings();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
      });
    });

    it("clicking toggle sends SET_SYNC_ARCHIVED message", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED") {
            return Promise.resolve({ syncArchived: 0 });
          }
          if (msg.type === "SET_SYNC_ARCHIVED") {
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve(undefined);
        },
      );

      renderFamilySettings();

      await waitFor(() => {
        expect(
          screen.getByRole("switch", { name: "同步封存書籍" }),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("switch", { name: "同步封存書籍" }));

      // Should have sent SET_SYNC_ARCHIVED with value 1 (no Chrome callback arg)
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_SYNC_ARCHIVED", syncArchived: 1 }),
      );
    });

    it("reverts toggle state when SET_SYNC_ARCHIVED response is not ok", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED") {
            return Promise.resolve({ syncArchived: 0 });
          }
          if (msg.type === "SET_SYNC_ARCHIVED") {
            return Promise.resolve({ ok: false });
          }
          return Promise.resolve(undefined);
        },
      );

      renderFamilySettings();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
      });

      fireEvent.click(screen.getByRole("switch", { name: "同步封存書籍" }));

      // Should revert back to false after failed response
      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
      });
    });
  });

  describe("members loading error", () => {
    it("shows error message when getFamilyMembers fails", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "無法載入成員" },
        }),
      });

      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("無法載入成員")).toBeInTheDocument();
      });
    });

    it("shows retry button when members fail to load", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "載入失敗" },
        }),
      });

      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("載入失敗")).toBeInTheDocument();
        expect(screen.getByText("重試")).toBeInTheDocument();
      });
    });

    it("retry button re-fetches members", async () => {
      const successData = {
        data: {
          familyId: "fam-123",
          ownerId: "user-abc12345",
          members: [{ userId: "user-abc12345", displayName: "小明" }],
          maxMembers: 6,
          createdAt: "2026-01-01",
        },
      };
      const errorResponse = {
        error: { code: "INTERNAL_ERROR", message: "載入失敗" },
      };
      const getFamilyMembers = vi
        .fn()
        .mockResolvedValueOnce(errorResponse)
        .mockResolvedValue(successData);

      const apiClient = createMockApiClient({ getFamilyMembers });
      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("載入失敗")).toBeInTheDocument();
      });

      const callsBefore = getFamilyMembers.mock.calls.length;

      fireEvent.click(screen.getByText("重試"));

      await waitFor(() => {
        expect(screen.getByText("小明")).toBeInTheDocument();
      });

      // Verify retry caused additional call(s)
      expect(getFamilyMembers.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("updates member display name on chrome.storage.onChanged", async () => {
    renderFamilySettings();

    // Wait for members to load
    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });

    // Get the listener registered on chrome.storage.onChanged
    const addListenerCalls = vi.mocked(chrome.storage.onChanged.addListener)
      .mock.calls;
    const listener = addListenerCalls[addListenerCalls.length - 1][0];

    // Simulate storage change for displayName
    act(() => {
      listener(
        { [DISPLAY_NAME_KEY]: { newValue: "大明", oldValue: "小明" } },
        "local",
      );
    });

    // Both the display-name section AND the member list should reflect "大明"
    // because both are now sourced from the same FamilyDataContext members state.
    await waitFor(() => {
      expect(screen.getAllByText("大明").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("ignores chrome.storage.onChanged from non-local area", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
    });

    const addListenerCalls = vi.mocked(chrome.storage.onChanged.addListener)
      .mock.calls;
    const listener = addListenerCalls[addListenerCalls.length - 1][0];

    // Fire from "sync" area — should be ignored
    act(() => {
      listener(
        { [DISPLAY_NAME_KEY]: { newValue: "不應出現", oldValue: "小明" } },
        "sync",
      );
    });

    expect(screen.queryByText("不應出現")).not.toBeInTheDocument();
  });

  describe("leave family errors", () => {
    it("shows generic error when leave throws an exception", async () => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockRejectedValue(new Error("Network down")),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText("Network down")).toBeInTheDocument();
      });

      // Should return to idle state after error
      await waitFor(() => {
        expect(screen.getByText("離開家庭")).toBeInTheDocument();
      });
    });

    it("handles non-Error exception during leave", async () => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockRejectedValue("string error"),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText("發生未知錯誤")).toBeInTheDocument();
      });
    });

    it("calls onLeave after successful leave", async () => {
      const onLeave = vi.fn();
      renderFamilySettings({ onLeave });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(onLeave).toHaveBeenCalledOnce();
      });
    });

    it("shows 離開中... during leave process", async () => {
      let resolveLeave: (value: unknown) => void;
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveLeave = resolve;
            }),
        ),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText("離開中...")).toBeInTheDocument();
      });

      // Resolve to clean up
      resolveLeave!({ data: { ok: true } });
    });
  });

  describe("delete account", () => {
    it("shows 移除帳戶 button", async () => {
      renderFamilySettings();

      await waitFor(() => {
        expect(screen.getByText("移除帳戶")).toBeInTheDocument();
      });
    });

    it("shows confirmation dialog when clicking delete button", async () => {
      renderFamilySettings();

      fireEvent.click(screen.getByText("移除帳戶"));

      await waitFor(() => {
        expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
        expect(screen.getByText("確定移除")).toBeInTheDocument();
      });
    });

    it("calls deleteAccount API and onLeave on confirm", async () => {
      const apiClient = createMockApiClient();
      const onLeave = vi.fn();
      renderFamilySettings({ apiClient, onLeave });

      fireEvent.click(screen.getByText("移除帳戶"));

      await waitFor(() => {
        expect(screen.getByText("確定移除")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定移除"));

      await waitFor(() => {
        expect(apiClient.deleteAccount).toHaveBeenCalledWith("user-abc12345");
        expect(onLeave).toHaveBeenCalled();
      });
    });

    it("shows owner error when OWNER_CANNOT_DELETE", async () => {
      const apiClient = createMockApiClient({
        deleteAccount: vi.fn().mockResolvedValue({
          error: {
            code: "OWNER_CANNOT_DELETE",
            message: "Owner cannot delete",
          },
        }),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("移除帳戶"));

      await waitFor(() => {
        expect(screen.getByText("確定移除")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定移除"));

      await waitFor(() => {
        expect(
          screen.getByText("管理者必須先轉移管理權才能移除帳戶"),
        ).toBeInTheDocument();
      });
    });

    it("cancel returns to idle delete state", async () => {
      renderFamilySettings();

      fireEvent.click(screen.getByText("移除帳戶"));

      await waitFor(() => {
        expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
      });

      // Find cancel buttons; last one is for delete section
      const cancelButtons = screen.getAllByText("取消");
      fireEvent.click(cancelButtons[cancelButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText("移除帳戶")).toBeInTheDocument();
        expect(
          screen.queryByText("確定要移除帳戶嗎？"),
        ).not.toBeInTheDocument();
      });
    });
  });

  /**
   * The family record's `apiEndpoint` is chosen by the family OWNER and pushed
   * to every member, so adopting it silently would let the owner redirect
   * another member's auth token and full book list (unshared books included) to
   * a host of their choosing. The Settings tab asks first — the security
   * contract lives in src/dialog/useEndpointSwitch.ts.
   */
  describe("family endpoint switch confirmation", () => {
    const CURRENT_ENDPOINT = "https://current.example";
    const FAMILY_ENDPOINT = "https://family.example";

    /** Members response carrying the family record's advertised endpoint. */
    function membersWithEndpoint(apiEndpoint: string | null) {
      return vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-123",
          ownerId: "user-abc12345",
          members: [{ userId: "user-abc12345", displayName: "小明" }],
          maxMembers: 6,
          createdAt: "2026-01-01",
          apiEndpoint,
        },
      });
    }

    /**
     * The mock client is STATEFUL, like the real `ApiClient`: `setEndpoint`
     * moves what `getEndpoint` reports, through the production validator so the
     * stored value is canonical.
     *
     * This matters because `useEndpointSwitch` re-reads `getEndpoint()` after a
     * successful switch to decide what the sync code advertises. A frozen
     * `getEndpoint` would keep answering with the pre-switch endpoint and hide
     * exactly the drift the "sync code follows the adopted endpoint" block
     * exists to catch.
     *
     * `opts.setEndpoint` overrides the whole behaviour (used to simulate a
     * client that refuses the target), and then nothing moves.
     */
    function renderWithEndpoints(opts: {
      current: string;
      family: string | null;
      setEndpoint?: (url: string) => void;
    }): ApiClient {
      let endpoint = opts.current;
      const apiClient = createMockApiClient({
        getEndpoint: vi.fn(() => endpoint),
        setEndpoint: vi.fn((url: string) => {
          if (opts.setEndpoint) {
            opts.setEndpoint(url);
            return;
          }
          endpoint = validateEndpointUrl(url);
        }),
        getFamilyMembers: membersWithEndpoint(opts.family),
      });
      renderFamilySettings({ apiClient });
      return apiClient;
    }

    it("asks before adopting the endpoint the family record advertises", async () => {
      renderWithEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      const panel = await screen.findByTestId("endpoint-switch");

      // It interrupts the Settings tab with a security decision, so it is
      // announced to assistive tech the moment it appears.
      expect(panel).toHaveAttribute("role", "alert");
      expect(
        within(panel).getByText("⚠️ 家庭 API 端點已變更"),
      ).toBeInTheDocument();
      expect(within(panel).getByText("目前連線")).toBeInTheDocument();
      expect(within(panel).getByText(CURRENT_ENDPOINT)).toBeInTheDocument();
      expect(within(panel).getByText("將切換至")).toBeInTheDocument();
      expect(within(panel).getByText(FAMILY_ENDPOINT)).toBeInTheDocument();
      expect(
        within(panel).getByText(
          "切換後，你的認證資訊與完整書單（包含未開放的書籍）都會傳送到新的伺服器。請確認你信任這個位址再切換。",
        ),
      ).toBeInTheDocument();
      expect(
        within(panel).getByText(
          "選擇「暫不切換」後會保持目前的連線，除非家庭端點再次變更，否則不會再詢問。",
        ),
      ).toBeInTheDocument();
      // Keeping the current endpoint is the safe choice, so it comes first.
      expect(
        within(panel)
          .getAllByRole("button")
          .map((btn) => btn.textContent),
      ).toEqual(["暫不切換", "確認切換"]);
    });

    it("labels a revert to the official default endpoint", async () => {
      renderWithEndpoints({ current: CURRENT_ENDPOINT, family: null });

      const panel = await screen.findByTestId("endpoint-switch");

      expect(
        within(panel).getByText("將切換至（官方預設端點）"),
      ).toBeInTheDocument();
      expect(within(panel).queryByText("將切換至")).not.toBeInTheDocument();
      expect(within(panel).getByText(DEFAULT_API_ENDPOINT)).toBeInTheDocument();
    });

    it("asks nothing when the family endpoint is already in effect", async () => {
      renderWithEndpoints({
        current: FAMILY_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      await waitFor(() => {
        expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
      });

      // The panel is mounted unconditionally, so "nothing to say" must render
      // as nothing at all — neither the question nor a failure notice.
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("endpoint-switch-error"),
      ).not.toBeInTheDocument();
    });

    it("asks nothing while the member list is still loading", async () => {
      let resolveMembers: (value: unknown) => void = () => {};
      const apiClient = createMockApiClient({
        getEndpoint: vi.fn().mockReturnValue(CURRENT_ENDPOINT),
        getFamilyMembers: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveMembers = resolve;
            }),
        ),
      });
      renderFamilySettings({ apiClient });

      await act(async () => {});
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();

      await act(async () => {
        resolveMembers({
          data: {
            familyId: "fam-123",
            ownerId: "user-abc12345",
            members: [{ userId: "user-abc12345", displayName: "小明" }],
            maxMembers: 6,
            createdAt: "2026-01-01",
            apiEndpoint: FAMILY_ENDPOINT,
          },
        });
      });

      expect(await screen.findByTestId("endpoint-switch")).toBeInTheDocument();
    });

    it("confirm switches the client, persists the endpoint, and closes the panel", async () => {
      const apiClient = renderWithEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      const panel = await screen.findByTestId("endpoint-switch");
      fireEvent.click(within(panel).getByText("確認切換"));

      expect(apiClient.setEndpoint).toHaveBeenCalledWith(FAMILY_ENDPOINT);
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();

      await waitFor(() => {
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [API_ENDPOINT_KEY]: FAMILY_ENDPOINT,
        });
      });
      await waitFor(() => {
        expect(chrome.storage.local.remove).toHaveBeenCalledWith([
          DECLINED_FAMILY_ENDPOINT_KEY,
        ]);
      });
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_API_ENDPOINT",
        apiEndpoint: FAMILY_ENDPOINT,
      });
      // Accepting must never leave a refusal behind.
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({
          [DECLINED_FAMILY_ENDPOINT_KEY]: expect.anything(),
        }),
      );
    });

    it("decline records the refusal and leaves the endpoint untouched", async () => {
      const apiClient = renderWithEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      const panel = await screen.findByTestId("endpoint-switch");
      fireEvent.click(within(panel).getByText("暫不切換"));

      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
      expect(apiClient.setEndpoint).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [DECLINED_FAMILY_ENDPOINT_KEY]: { value: FAMILY_ENDPOINT },
        });
      });
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
      );
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_API_ENDPOINT" }),
      );
    });

    it("does not ask again for an endpoint the user already declined", async () => {
      mockStorageGet({
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: FAMILY_ENDPOINT },
      });

      renderWithEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      await waitFor(() => {
        expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
      });

      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
    });

    it("asks again once the family record moves to a different endpoint", async () => {
      mockStorageGet({
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: "https://declined.example" },
      });

      renderWithEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      const panel = await screen.findByTestId("endpoint-switch");
      expect(within(panel).getByText(FAMILY_ENDPOINT)).toBeInTheDocument();
    });

    it("keeps the current endpoint when the client rejects the family endpoint", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const apiClient = renderWithEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
        setEndpoint: () => {
          throw new Error("Unsafe API endpoint scheme");
        },
      });

      const panel = await screen.findByTestId("endpoint-switch");
      fireEvent.click(within(panel).getByText("確認切換"));

      expect(apiClient.setEndpoint).toHaveBeenCalledWith(FAMILY_ENDPOINT);
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();

      // A panel that just closes reads as "switched successfully", so the
      // refusal is stated instead — text asserted on the rendered production
      // output (src/dialog/EndpointSwitchPanel.tsx), never a copy of it.
      const notice = await screen.findByTestId("endpoint-switch-error");
      expect(notice).toHaveAttribute("role", "alert");
      expect(
        within(notice).getByText(
          "此位址無法使用（需為 HTTPS，或本機／私人網路的 HTTP），已略過此次切換。",
        ),
      ).toBeInTheDocument();

      // Nothing changed, and the unusable value is filed as declined so a
      // broken record cannot re-open the panel on every members refresh.
      await waitFor(() => {
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [DECLINED_FAMILY_ENDPOINT_KEY]: { value: FAMILY_ENDPOINT },
        });
      });
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
      );
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    it("dismisses the failure notice with 「知道了」 and leaves the question closed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      renderWithEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
        setEndpoint: () => {
          throw new Error("Unsafe API endpoint scheme");
        },
      });

      const panel = await screen.findByTestId("endpoint-switch");
      fireEvent.click(within(panel).getByText("確認切換"));

      const notice = await screen.findByTestId("endpoint-switch-error");
      fireEvent.click(within(notice).getByText("知道了"));

      await waitFor(() => {
        expect(
          screen.queryByTestId("endpoint-switch-error"),
        ).not.toBeInTheDocument();
      });
      // Acknowledging is not a retry: the refused value stays declined, so the
      // confirmation panel must not reappear behind the dismissed notice.
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();

      warn.mockRestore();
    });

    /**
     * The sync code is what this member hands to the next person (and re-scans
     * onto their own phone), so its `@host` must describe the endpoint THIS
     * device has actually ADOPTED — never the family record's advertised value.
     *
     * Building it from the record would mean a member who DECLINED a switch
     * still distributes the endpoint they refused: the invitee lands on the
     * untrusted host while the decliner never does, so the refusal protects
     * only the person who made it.
     */
    describe("sync code follows the adopted endpoint", () => {
      /** Read the rendered sync code once the members request has settled. */
      async function readSyncCode(): Promise<string> {
        await waitFor(() => {
          expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
        });
        return screen.getByTestId("sync-code").textContent ?? "";
      }

      it("carries no @host while this device is on the official default", async () => {
        renderWithEndpoints({
          current: DEFAULT_API_ENDPOINT,
          family: null,
        });

        expect(await readSyncCode()).toBe("moo-fam-123");
      });

      it("carries the @host when owner and member are already aligned on a custom endpoint", async () => {
        renderWithEndpoints({
          current: FAMILY_ENDPOINT,
          family: FAMILY_ENDPOINT,
        });

        expect(await readSyncCode()).toBe(`moo-fam-123@${FAMILY_ENDPOINT}`);
        // Aligned already, so there was nothing to confirm.
        expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
      });

      it("keeps the code @host-free after declining a switch to a custom endpoint", async () => {
        renderWithEndpoints({
          current: DEFAULT_API_ENDPOINT,
          family: FAMILY_ENDPOINT,
        });

        const panel = await screen.findByTestId("endpoint-switch");
        expect(screen.getByTestId("sync-code")).toHaveTextContent(
          "moo-fam-123",
        );

        fireEvent.click(within(panel).getByText("暫不切換"));

        // The refused endpoint must not travel out in the invite.
        const code = await readSyncCode();
        expect(code).toBe("moo-fam-123");
        expect(code).not.toContain(FAMILY_ENDPOINT);
      });

      it("keeps the custom @host after declining a revert to the official default", async () => {
        renderWithEndpoints({
          current: CURRENT_ENDPOINT,
          family: null,
        });

        const panel = await screen.findByTestId("endpoint-switch");
        fireEvent.click(within(panel).getByText("暫不切換"));

        // This device stays on its custom endpoint, so an invite that dropped
        // the @host would send the invitee to the wrong (default) server.
        expect(await readSyncCode()).toBe(`moo-fam-123@${CURRENT_ENDPOINT}`);
      });

      it("adds the new @host as soon as a switch is confirmed, with no reopen", async () => {
        renderWithEndpoints({
          current: DEFAULT_API_ENDPOINT,
          family: FAMILY_ENDPOINT,
        });

        const panel = await screen.findByTestId("endpoint-switch");
        expect(screen.getByTestId("sync-code")).toHaveTextContent(
          "moo-fam-123",
        );

        fireEvent.click(within(panel).getByText("確認切換"));

        // Same mount: `apiClient.setEndpoint` alone would not re-render, so the
        // code would otherwise stay stale until the dialog was reopened.
        await waitFor(() => {
          expect(screen.getByTestId("sync-code")).toHaveTextContent(
            `moo-fam-123@${FAMILY_ENDPOINT}`,
          );
        });
      });

      it("drops the @host as soon as a revert to the official default is confirmed", async () => {
        renderWithEndpoints({
          current: CURRENT_ENDPOINT,
          family: null,
        });

        const panel = await screen.findByTestId("endpoint-switch");
        expect(screen.getByTestId("sync-code")).toHaveTextContent(
          `moo-fam-123@${CURRENT_ENDPOINT}`,
        );

        fireEvent.click(within(panel).getByText("確認切換"));

        await waitFor(() => {
          expect(screen.getByTestId("sync-code").textContent).toBe(
            "moo-fam-123",
          );
        });
      });

      it("keeps the current @host when a confirmed switch is refused by URL validation", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        renderWithEndpoints({
          current: CURRENT_ENDPOINT,
          family: FAMILY_ENDPOINT,
          setEndpoint: () => {
            throw new Error("Unsafe API endpoint scheme");
          },
        });

        const panel = await screen.findByTestId("endpoint-switch");
        fireEvent.click(within(panel).getByText("確認切換"));

        await screen.findByTestId("endpoint-switch-error");
        // Nothing switched, so nothing about the shared code may change.
        expect(screen.getByTestId("sync-code").textContent).toBe(
          `moo-fam-123@${CURRENT_ENDPOINT}`,
        );

        warn.mockRestore();
      });

      it("copies the adopted-endpoint code, not the family record's", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });

        renderWithEndpoints({
          current: DEFAULT_API_ENDPOINT,
          family: FAMILY_ENDPOINT,
        });

        const panel = await screen.findByTestId("endpoint-switch");
        fireEvent.click(within(panel).getByText("暫不切換"));
        await readSyncCode();

        fireEvent.click(screen.getByText("複製同步碼"));

        await waitFor(() => expect(writeText).toHaveBeenCalled());
        const copied = writeText.mock.calls[0][0] as string;
        expect(copied).toContain("moo-fam-123");
        expect(copied).not.toContain(FAMILY_ENDPOINT);
      });
    });
  });
});
