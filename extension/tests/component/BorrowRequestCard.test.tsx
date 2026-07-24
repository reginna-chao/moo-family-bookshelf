import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  BorrowRequestCard,
  type BorrowAction,
} from "@/dialog/BorrowRequestCard";
import { BorrowStatus, type BorrowRequest } from "@/api/client";

const REQUEST: BorrowRequest = {
  requestId: "req-1",
  familyId: "fam-1",
  borrowerId: "user-borrower",
  borrowerName: "小華",
  ownerId: "user-owner",
  bookId: "book-1",
  bookTitle: "深度學習",
  bookAuthor: "作者甲",
  bookCoverUrl: "https://cdn.example/cover.jpg",
  status: BorrowStatus.PENDING,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderCard(actions: BorrowAction[]) {
  return render(
    <BorrowRequestCard
      request={REQUEST}
      otherPartyName="小華"
      actions={actions}
    />,
  );
}

describe("BorrowRequestCard", () => {
  it("renders the book, the other party and the status label", () => {
    renderCard([]);

    expect(screen.getByText("深度學習")).toBeInTheDocument();
    expect(screen.getByText("作者甲")).toBeInTheDocument();
    expect(screen.getByText("小華")).toBeInTheDocument();
    expect(screen.getByText("待處理")).toBeInTheDocument();
  });

  it("invokes the action's onClick when its button is pressed", () => {
    const onClick = vi.fn();
    renderCard([{ label: "同意出借", onClick, variant: "primary" }]);

    fireEvent.click(screen.getByRole("button", { name: "同意出借" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a disabled action", () => {
    const onClick = vi.fn();
    renderCard([{ label: "同意出借", onClick, disabled: true }]);

    const button = screen.getByRole("button", { name: "同意出借" });
    expect(button).toBeDisabled();
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  /**
   * The three action variants were re-based on the shared `.moo-button`
   * component class; the per-variant look is now expressed through modifiers
   * that only override CSS variables. jsdom does not apply the stylesheet, so
   * the class list is the observable contract — asserting it catches a variant
   * that loses its shared base (the exact regression this refactor risks).
   */
  describe("shared .moo-button class contract", () => {
    it.each([
      {
        variant: "primary" as const,
        expected: ["moo-button", "moo-button--sm", "moo-request-card__action"],
        forbidden: ["moo-button--ghost", "moo-button--outline-danger"],
      },
      {
        variant: "danger" as const,
        expected: [
          "moo-button",
          "moo-button--sm",
          "moo-button--outline-danger",
          "moo-request-card__action",
        ],
        forbidden: ["moo-button--ghost"],
      },
      {
        variant: "secondary" as const,
        expected: [
          "moo-button",
          "moo-button--sm",
          "moo-button--ghost",
          "moo-request-card__action",
        ],
        forbidden: ["moo-button--outline-danger"],
      },
    ])(
      "gives the $variant action the shared button base",
      ({ variant, expected, forbidden }) => {
        renderCard([{ label: "操作", onClick: vi.fn(), variant }]);

        const button = screen.getByRole("button", { name: "操作" });
        for (const cls of expected) expect(button).toHaveClass(cls);
        for (const cls of forbidden) expect(button).not.toHaveClass(cls);
      },
    );

    it("falls back to the secondary variant when none is given", () => {
      renderCard([{ label: "操作", onClick: vi.fn() }]);

      const button = screen.getByRole("button", { name: "操作" });
      expect(button).toHaveClass("moo-button");
      expect(button).toHaveClass("moo-button--ghost");
      expect(button).toHaveClass("moo-request-card__action");
    });

    it("keeps the legacy per-variant modifiers alongside the shared base", () => {
      renderCard([
        { label: "同意", onClick: vi.fn(), variant: "primary" },
        { label: "拒絕", onClick: vi.fn(), variant: "danger" },
      ]);

      expect(screen.getByRole("button", { name: "同意" })).toHaveClass(
        "moo-request-card__action--primary",
      );
      expect(screen.getByRole("button", { name: "拒絕" })).toHaveClass(
        "moo-request-card__action--danger",
      );
    });
  });
});
