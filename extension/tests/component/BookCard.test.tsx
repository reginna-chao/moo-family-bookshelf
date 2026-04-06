import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { BookCard, FilterButton, BookWithMember } from "@/dialog/BookCard";
import { BoolFlag } from "@/api/client";

function makeBook(overrides: Partial<BookWithMember> = {}): BookWithMember {
  return {
    bookId: "book-1",
    title: "測試書籍",
    author: "測試作者",
    isbn: "",
    coverUrl: "https://example.com/cover.jpg",
    readmooUrl: "https://readmoo.com/book/book-1",
    category: "",
    isShared: BoolFlag.FALSE,
    isUpdated: BoolFlag.FALSE,
    memberName: "小明",
    ...overrides,
  };
}

describe("BookCard", () => {
  it("renders a cover image with alt text", () => {
    render(<BookCard book={makeBook()} />);

    const img = screen.getByAltText("測試書籍") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe("https://example.com/cover.jpg");
  });

  it("wraps cover image in a link to readmooUrl", () => {
    render(<BookCard book={makeBook()} />);

    const img = screen.getByAltText("測試書籍");
    const link = img.closest("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.href).toBe("https://readmoo.com/book/book-1");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("renders book title as a link to readmooUrl", () => {
    render(<BookCard book={makeBook()} />);

    const titleLink = screen.getByText("測試書籍") as HTMLAnchorElement;
    expect(titleLink.tagName).toBe("A");
    expect(titleLink.href).toBe("https://readmoo.com/book/book-1");
    expect(titleLink.target).toBe("_blank");
  });

  it("title has ellipsis-related styles for 2-line clamp", () => {
    render(<BookCard book={makeBook()} />);

    const titleLink = screen.getByText("測試書籍") as HTMLElement;
    expect(titleLink.style.overflow).toBe("hidden");
    expect(titleLink.style.textOverflow).toBe("ellipsis");
    expect(titleLink.style.webkitLineClamp).toBe("2");
  });

  it("renders author when present", () => {
    render(<BookCard book={makeBook({ author: "作者A" })} />);

    expect(screen.getByText("作者A")).toBeInTheDocument();
  });

  it("does not render author span when author is empty", () => {
    const { container } = render(<BookCard book={makeBook({ author: "" })} />);

    // The author span has fontSize 12 and color #94a3b8
    const spans = container.querySelectorAll("span");
    const authorSpans = Array.from(spans).filter(
      (s) => s.style.fontSize === "12px" && s.style.color === "rgb(148, 163, 184)",
    );
    expect(authorSpans).toHaveLength(0);
  });

  it("renders member name badge", () => {
    render(<BookCard book={makeBook({ memberName: "大明" })} />);

    const badge = screen.getByText("大明");
    expect(badge).toBeInTheDocument();
    expect(badge.tagName).toBe("SPAN");
  });

  it("member name badge has blue styling", () => {
    render(<BookCard book={makeBook({ memberName: "小明" })} />);

    const badge = screen.getByText("小明");
    expect(badge.style.color).toBe("rgb(37, 99, 235)");
    expect(badge.style.background).toBe("rgb(239, 246, 255)");
    expect(badge.style.borderRadius).toBe("8px");
  });

  it("renders with a long title without error", () => {
    const longTitle = "這是一個非常長的書名，用來測試文字截斷功能是否正常運作，超過兩行後應該要顯示省略號";
    render(<BookCard book={makeBook({ title: longTitle })} />);

    expect(screen.getByText(longTitle)).toBeInTheDocument();
  });

  it("does not render category label", () => {
    render(<BookCard book={makeBook({ category: "韓國耽美" })} />);

    // Category should not be displayed on BookCard
    expect(screen.queryByText("韓國耽美")).not.toBeInTheDocument();
  });
});

describe("FilterButton", () => {
  it("renders label text", () => {
    render(<FilterButton label="全部" active={false} onClick={() => {}} />);

    expect(screen.getByText("全部")).toBeInTheDocument();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<FilterButton label="全部" active={false} onClick={onClick} />);

    fireEvent.click(screen.getByText("全部"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("has active styling when active is true", () => {
    render(<FilterButton label="已開放" active={true} onClick={() => {}} />);

    const btn = screen.getByText("已開放");
    expect(btn.style.color).toBe("rgb(37, 99, 235)");
    expect(btn.style.fontWeight).toBe("600");
    expect(btn.style.background).toBe("rgb(239, 246, 255)");
  });

  it("has inactive styling when active is false", () => {
    render(<FilterButton label="已開放" active={false} onClick={() => {}} />);

    const btn = screen.getByText("已開放");
    expect(btn.style.color).toBe("rgb(100, 116, 139)");
    expect(btn.style.fontWeight).toBe("400");
    expect(btn.style.background).toBe("transparent");
  });

  it("renders as a button element", () => {
    render(<FilterButton label="測試" active={false} onClick={() => {}} />);

    expect(screen.getByRole("button", { name: "測試" })).toBeInTheDocument();
  });
});
