import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  findBookCardInLibrary,
  extractReadmooMembers,
  selectMemberByName,
  waitForLendDialogClose,
  closeLendDialog,
  READMOO_LEND_DEFAULTS,
} from "@/content/readmoo-lend";

describe("readmoo-lend", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("findBookCardInLibrary", () => {
    it("finds a library item by data-moo-book-id", () => {
      document.body.innerHTML = `
        <div class="library-item" data-moo-book-id="abc123"></div>
        <div class="library-item" data-moo-book-id="xyz789"></div>
      `;
      const found = findBookCardInLibrary("xyz789");
      expect(found).not.toBeNull();
      expect(found?.getAttribute("data-moo-book-id")).toBe("xyz789");
    });

    it("returns null when bookId is not in DOM", () => {
      document.body.innerHTML = `<div class="library-item" data-moo-book-id="abc123"></div>`;
      expect(findBookCardInLibrary("missing")).toBeNull();
    });

    it("returns null when DOM is empty", () => {
      expect(findBookCardInLibrary("anything")).toBeNull();
    });

    it("escapes special CSS characters in bookId to avoid selector injection", () => {
      document.body.innerHTML = `<div class="library-item" data-moo-book-id="weird&quot;id"></div>`;
      // The escaping should not throw and should still match correctly
      expect(() => findBookCardInLibrary('weird"id')).not.toThrow();
    });
  });

  describe("extractReadmooMembers", () => {
    it("extracts member name + avatar from list-group items", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <div class="list-group-item">
          <img src="https://example.com/cry.png" alt="CRY" />
          <span class="fw-bold">CRY</span>
        </div>
        <div class="list-group-item">
          <img src="https://example.com/alice.png" alt="Alice" />
          <span class="fw-bold">Alice</span>
        </div>
      `;
      const members = extractReadmooMembers(dialog);
      expect(members).toEqual([
        { name: "CRY", avatar: "https://example.com/cry.png" },
        { name: "Alice", avatar: "https://example.com/alice.png" },
      ]);
    });

    it("skips items without a name", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <div class="list-group-item"><span class="fw-bold"></span></div>
        <div class="list-group-item"><span class="fw-bold">Bob</span></div>
      `;
      const members = extractReadmooMembers(dialog);
      expect(members).toHaveLength(1);
      expect(members[0].name).toBe("Bob");
    });

    it("returns empty array when dialog has no member items", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `<div class="other"></div>`;
      expect(extractReadmooMembers(dialog)).toEqual([]);
    });

    it("returns empty avatar when img is missing", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <div class="list-group-item">
          <span class="fw-bold">NoAvatar</span>
        </div>
      `;
      const members = extractReadmooMembers(dialog);
      expect(members[0]).toEqual({ name: "NoAvatar", avatar: "" });
    });
  });

  describe("selectMemberByName", () => {
    it("clicks the matching member's list-group-item and returns true", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <button class="list-group-item"><span class="fw-bold">CRY</span></button>
        <button class="list-group-item"><span class="fw-bold">Alice</span></button>
      `;
      document.body.appendChild(dialog);
      const aliceBtn = dialog.querySelectorAll("button")[1];
      const clickSpy = vi.fn();
      aliceBtn.addEventListener("click", clickSpy);

      const result = selectMemberByName(dialog, "Alice");

      expect(result).toBe(true);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("returns false when no match (does not throw)", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <button class="list-group-item"><span class="fw-bold">CRY</span></button>
      `;
      expect(() => selectMemberByName(dialog, "Missing")).not.toThrow();
      expect(selectMemberByName(dialog, "Missing")).toBe(false);
    });

    it("trims whitespace when comparing names", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <button class="list-group-item"><span class="fw-bold">  CRY  </span></button>
      `;
      const btn = dialog.querySelector("button")!;
      const clickSpy = vi.fn();
      btn.addEventListener("click", clickSpy);

      const result = selectMemberByName(dialog, "CRY");

      expect(result).toBe(true);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("closeLendDialog", () => {
    it("clicks the dialog's .btn-close when present", () => {
      const dialog = document.createElement("div");
      const close = document.createElement("button");
      close.className = "btn-close";
      const clickSpy = vi.fn();
      close.addEventListener("click", clickSpy);
      dialog.appendChild(close);
      document.body.appendChild(dialog);

      closeLendDialog(dialog);

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to dispatching Escape keydown when no .btn-close", () => {
      const dialog = document.createElement("div");
      const keySpy = vi.fn();
      dialog.addEventListener("keydown", keySpy);
      document.body.appendChild(dialog);

      closeLendDialog(dialog);

      expect(keySpy).toHaveBeenCalledTimes(1);
      expect((keySpy.mock.calls[0][0] as KeyboardEvent).key).toBe("Escape");
    });

    it("does nothing when the dialog is already disconnected", () => {
      const dialog = document.createElement("div");
      // never appended → not connected
      expect(() => closeLendDialog(dialog)).not.toThrow();
    });
  });

  describe("waitForLendDialogClose", () => {
    it("resolves true when dialog is removed from DOM", async () => {
      const dialog = document.createElement("div");
      document.body.appendChild(dialog);
      const promise = waitForLendDialogClose(dialog, 1000);
      // Schedule removal on next tick
      queueMicrotask(() => dialog.remove());
      const result = await promise;
      expect(result).toBe(true);
    });

    it("resolves true immediately when dialog is already disconnected", async () => {
      const dialog = document.createElement("div");
      // never appended → not connected
      const result = await waitForLendDialogClose(dialog, 100);
      expect(result).toBe(true);
    });

    it("resolves false when timeout elapses with dialog still in DOM", async () => {
      const dialog = document.createElement("div");
      document.body.appendChild(dialog);
      const result = await waitForLendDialogClose(dialog, 50);
      expect(result).toBe(false);
    });
  });

  describe("constants", () => {
    it("exports default timeouts", () => {
      expect(READMOO_LEND_DEFAULTS.modalOpenTimeoutMs).toBeGreaterThan(0);
      expect(READMOO_LEND_DEFAULTS.lendDialogOpenTimeoutMs).toBeGreaterThan(0);
      expect(READMOO_LEND_DEFAULTS.lendDialogCloseTimeoutMs).toBeGreaterThan(0);
    });
  });
});
