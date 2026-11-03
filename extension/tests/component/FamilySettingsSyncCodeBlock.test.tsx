import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { FamilySettingsSyncCodeBlock } from "@/dialog/FamilySettingsSyncCodeBlock";

/**
 * FamilySettingsSyncCodeBlock rendered on its own, for the one state `FamilySettings` cannot show:
 * `syncCode === null`. `FamilySettings` sets the code in a mount effect, so in its tests the block
 * is never observed without one. While the code is missing, the square 複製邀請網址 button must be
 * disabled like the two copy buttons beside it. `SyncCodeTextFrame` and `InviteQrCode` render only
 * with a code, so nothing needs stubbing here.
 */

describe("FamilySettingsSyncCodeBlock", () => {
  it("disables the invite-URL copy button while the sync code is missing", () => {
    render(
      <FamilySettingsSyncCodeBlock
        syncCode={null}
        copied={false}
        inviteCopied={false}
        linkCopied={false}
        onCopy={vi.fn()}
        onInviteCopy={vi.fn()}
        onLinkCopy={vi.fn()}
      />,
    );

    expect(screen.getByText("載入中...")).toBeInTheDocument();
    // Same row as the invite-message button, which is disabled for the same reason.
    expect(
      screen.getByRole("button", { name: "邀請成員加入家庭" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "複製邀請網址" })).toBeDisabled();
  });
});
