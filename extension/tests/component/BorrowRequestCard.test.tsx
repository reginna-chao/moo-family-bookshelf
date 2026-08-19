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

function renderCard(actions: BorrowAction[], request: BorrowRequest = REQUEST) {
  return render(
    <BorrowRequestCard
      request={request}
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

  /**
   * `request.status` is bare-cast out of the API response by
   * `listBorrowRequests()`, and the API endpoint is user-configurable (BYO
   * backend), so an out-of-enum value can reach this render. The badge lookup
   * is a Map rather than an object literal precisely so a prototype-chain key
   * resolves to nothing, and a miss must degrade to the fallback badge — a
   * throw here takes down the whole Dialog, which has no ErrorBoundary.
   */
  describe("status badge", () => {
    const KNOWN_STATUS_CASES = [
      {
        status: BorrowStatus.PENDING,
        label: "待處理",
        modifier: "moo-request-card__status--pending",
      },
      {
        status: BorrowStatus.LENT,
        label: "出借中",
        modifier: "moo-request-card__status--lent",
      },
      {
        status: BorrowStatus.RETURNED,
        label: "已歸還",
        modifier: "moo-request-card__status--returned",
      },
      {
        status: BorrowStatus.REJECTED,
        label: "已拒絕",
        modifier: "moo-request-card__status--rejected",
      },
      {
        status: BorrowStatus.CANCELLED,
        label: "已取消",
        modifier: "moo-request-card__status--cancelled",
      },
    ];

    it.each(KNOWN_STATUS_CASES)(
      "labels the known status $status as $label",
      ({ status, label, modifier }) => {
        renderCard([], { ...REQUEST, status });

        const badge = screen.getByText(label);
        expect(badge).toHaveClass("moo-request-card__status");
        expect(badge).toHaveClass(modifier);
      },
    );

    // Replaces the exhaustiveness the old `Record<BorrowStatus, StatusMeta>`
    // gave us: a new enum member fails here until the table (and the Map)
    // cover it.
    it("covers every BorrowStatus member", () => {
      const members = Object.values(BorrowStatus).filter(
        (v): v is BorrowStatus => typeof v === "number",
      );
      expect(KNOWN_STATUS_CASES.map((c) => c.status).sort()).toEqual(
        members.sort(),
      );
    });

    it.each([
      { name: '"__proto__"', status: "__proto__" },
      { name: '"toString"', status: "toString" },
      { name: '"constructor"', status: "constructor" },
      { name: '"valueOf"', status: "valueOf" },
      { name: '"hasOwnProperty"', status: "hasOwnProperty" },
      { name: "an unknown numeric status (99)", status: 99 },
      // A backend that simply omits `status` is the likeliest out-of-range
      // case, and is exactly where the old object-literal lookup crashed
      // (`STATUS_META[undefined]` → reading `.modifier` of undefined).
      { name: "a null status", status: null },
      { name: "a missing status (undefined)", status: undefined },
    ])(
      "falls back to the unknown badge for $name instead of crashing",
      ({ status }) => {
        expect(() =>
          renderCard([], {
            ...REQUEST,
            status: status as unknown as BorrowStatus,
          }),
        ).not.toThrow();

        const badge = screen.getByText("狀態未知");
        expect(badge).toHaveClass("moo-request-card__status");
        expect(badge).toHaveClass("moo-request-card__status--returned");
        // A prototype-chain hit used to yield `undefined` as the modifier,
        // which React happily stringified into the class attribute.
        expect(badge.className).not.toContain("undefined");
      },
    );
  });
});
