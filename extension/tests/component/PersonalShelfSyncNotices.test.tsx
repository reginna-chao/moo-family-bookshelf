import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  PersonalShelfSyncNotices,
  autoShareHeldNotice,
  autoSharedBooksNotice,
  removedBooksNotice,
  renamedBooksNotice,
} from "@/dialog/PersonalShelfSyncNotices";
import type { SyncNoticeCounts } from "@/dialog/lastSync";

/**
 * The personal shelf's sync status lines: live progress, the sync error, and
 * the notices about the last successful sync — books moved to a new Readmoo
 * id (#236), books removed because Readmoo no longer holds them (#241), and
 * the 新書預設開放 pair (#238): books auto-shared, and new books held back
 * because one sync brought in more than the cap. The notice copy is pinned
 * here at its production builder; the removed notice has a with-shared and a
 * without-shared variant, one a prefix of the other, so both are asserted
 * with exact equality.
 */

function counts(overrides: Partial<SyncNoticeCounts> = {}): SyncNoticeCounts {
  return {
    renamedBookCount: 0,
    removedBookCount: 0,
    removedSharedCount: 0,
    autoSharedCount: 0,
    autoShareHeldCount: 0,
    ...overrides,
  };
}

describe("renamedBooksNotice", () => {
  it("pins the user-visible copy", () => {
    expect(renamedBooksNotice(2)).toBe(
      "讀墨更換了 2 本書的編號，書櫃已改用新編號，分享設定維持原本的選擇",
    );
  });
});

describe("removedBooksNotice", () => {
  it.each([
    {
      count: 3,
      sharedCount: 1,
      expected: "已移除 3 本讀墨書櫃裡已經沒有的書，其中 1 本原本設為分享",
    },
    {
      count: 2,
      sharedCount: 0,
      expected: "已移除 2 本讀墨書櫃裡已經沒有的書",
    },
  ])(
    "pins the copy for $count removed, $sharedCount shared",
    ({ count, sharedCount, expected }) => {
      expect(removedBooksNotice(count, sharedCount)).toBe(expected);
    },
  );
});

describe("autoSharedBooksNotice", () => {
  it("pins the user-visible copy", () => {
    expect(autoSharedBooksNotice(3)).toBe(
      "已自動開放 3 本新加入個人書櫃的書給家人，也會出現在你的公開書櫃",
    );
  });
});

describe("autoShareHeldNotice", () => {
  it("pins the user-visible copy, cap included", () => {
    expect(autoShareHeldNotice(150)).toBe(
      "這次新增了 150 本書，一次超過 100 本不會自動開放，請自己選要開放哪些",
    );
  });
});

describe("PersonalShelfSyncNotices", () => {
  it("renders nothing when there is nothing to report", () => {
    const { container } = render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the rename notice as a status with the production copy", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({ renamedBookCount: 1 })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(renamedBooksNotice(1));
    // Exact: the sibling count must not render.
    expect(screen.getByRole("status").textContent).toBe(renamedBooksNotice(1));
  });

  it("announces the removed notice with its shared count", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({ removedBookCount: 4, removedSharedCount: 2 })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "已移除 4 本讀墨書櫃裡已經沒有的書，其中 2 本原本設為分享",
    );
  });

  it("leaves the shared clause out when none of the removed books was shared", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({ removedBookCount: 1 })}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("已移除 1 本讀墨書櫃裡已經沒有的書");
    expect(status.textContent).not.toContain("原本設為分享");
  });

  it("shows no removed notice when nothing was removed, even with a stray shared count", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({ renamedBookCount: 1, removedSharedCount: 3 })}
      />,
    );
    // Positive companion: the rename status IS rendered, so the query is live.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(
      screen.queryByText(/讀墨書櫃裡已經沒有的書/),
    ).not.toBeInTheDocument();
  });

  it("shows the rename and the removed notices together", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({
          renamedBookCount: 2,
          removedBookCount: 3,
          removedSharedCount: 1,
        })}
      />,
    );
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toEqual([
      renamedBooksNotice(2),
      removedBooksNotice(3, 1),
    ]);
  });

  it("announces the auto-shared notice as a status with the production copy", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({ autoSharedCount: 2 })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "已自動開放 2 本新加入個人書櫃的書給家人，也會出現在你的公開書櫃",
    );
  });

  it("announces the held-back notice as a status with the production copy", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({ autoShareHeldCount: 101 })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "這次新增了 101 本書，一次超過 100 本不會自動開放，請自己選要開放哪些",
    );
    expect(screen.queryByText(/已自動開放/)).not.toBeInTheDocument();
  });

  it("shows no auto-share notice when both counts are 0", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({ renamedBookCount: 1 })}
      />,
    );
    // Positive companion: the rename status IS rendered, so the query is live.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText(/已自動開放/)).not.toBeInTheDocument();
    expect(screen.queryByText(/不會自動開放/)).not.toBeInTheDocument();
  });

  it("shows every notice together, in order", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        counts={counts({
          renamedBookCount: 1,
          removedBookCount: 2,
          autoSharedCount: 3,
          autoShareHeldCount: 120,
        })}
      />,
    );
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toEqual([
      renamedBooksNotice(1),
      removedBooksNotice(2, 0),
      autoSharedBooksNotice(3),
      autoShareHeldNotice(120),
    ]);
  });

  it("shows the progress line and the sync error independently", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage="正在讀取第 1 頁，已收集 10 本…"
        syncError="讀墨可能改版了，已暫停同步書櫃"
        counts={counts()}
      />,
    );
    expect(
      screen.getByText("正在讀取第 1 頁，已收集 10 本…"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("讀墨可能改版了，已暫停同步書櫃"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
