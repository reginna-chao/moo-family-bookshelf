import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  PersonalShelfSyncNotices,
  renamedBooksNotice,
} from "@/dialog/PersonalShelfSyncNotices";

describe("renamedBooksNotice", () => {
  it("pins the user-visible copy", () => {
    expect(renamedBooksNotice(2)).toBe(
      "讀墨更換了 2 本書的編號，書櫃已改用新編號，分享設定維持原本的選擇",
    );
  });
});

describe("PersonalShelfSyncNotices", () => {
  it("renders nothing when there is nothing to report", () => {
    const { container } = render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        renamedBookCount={0}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the rename notice as a status with the production copy", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage=""
        syncError=""
        renamedBookCount={1}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(renamedBooksNotice(1));
    // Exact: the sibling count must not render.
    expect(screen.getByRole("status").textContent).toBe(renamedBooksNotice(1));
  });

  it("shows the progress line and the sync error independently", () => {
    render(
      <PersonalShelfSyncNotices
        progressMessage="正在讀取第 1 頁，已收集 10 本…"
        syncError="讀墨可能改版了，已暫停同步書櫃"
        renamedBookCount={0}
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
