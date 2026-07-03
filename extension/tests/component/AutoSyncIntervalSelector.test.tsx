import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { AutoSyncIntervalSelector } from "@/dialog/AutoSyncIntervalSelector";
import type { AutoSyncInterval } from "@/dialog/useAutoSyncInterval";

describe("AutoSyncIntervalSelector", () => {
  it("renders a select with four labelled options", () => {
    render(<AutoSyncIntervalSelector value="daily" onChange={vi.fn()} />);

    const select = screen.getByLabelText("自動同步頻率");
    expect(select).toBeInTheDocument();

    // Contract: this select is auto-width and must NOT carry the full-width
    // modifier (that is MemberDropdown's; see MemberDropdown.tsx).
    expect(select).toHaveClass("moo-form-select");
    expect(select).not.toHaveClass("moo-form-select--full");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(4);
    expect(options.map((o) => o.textContent)).toEqual(["每天", "每 7 天", "每 30 天", "永不"]);
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      "daily",
      "weekly",
      "monthly",
      "never",
    ]);
  });

  it.each(["daily", "weekly", "monthly", "never"] as const)(
    "reflects value prop '%s' as the selected value",
    (value) => {
      render(<AutoSyncIntervalSelector value={value} onChange={vi.fn()} />);
      const select = screen.getByLabelText("自動同步頻率") as HTMLSelectElement;
      expect(select.value).toBe(value);
    },
  );

  it.each<{ from: AutoSyncInterval; to: AutoSyncInterval }>([
    { from: "daily", to: "weekly" },
    { from: "daily", to: "monthly" },
    { from: "weekly", to: "never" },
    { from: "monthly", to: "daily" },
  ])("calls onChange('$to') when a different option is chosen", ({ from, to }) => {
    const onChange = vi.fn();
    render(<AutoSyncIntervalSelector value={from} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("自動同步頻率"), { target: { value: to } });
    expect(onChange).toHaveBeenCalledWith(to);
  });
});
