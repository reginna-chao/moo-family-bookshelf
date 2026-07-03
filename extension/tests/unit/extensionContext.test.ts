import { describe, it, expect, afterEach } from "vitest";
import {
  MOO_ELEMENT_IDS,
  cleanupMooFamilyUI,
  isExtensionContextValid,
} from "@/utils/extensionContext";

/**
 * Covers the Shadow-DOM host teardown contract. After the isolation change the
 * dialog + backdrop live INSIDE the host's shadow tree, so `cleanupMooFamilyUI`
 * removes the light-DOM host (which drops its shadow subtree) plus the floating
 * button — it no longer targets the dialog/backdrop ids directly.
 */
describe("MOO_ELEMENT_IDS", () => {
  it("exposes the shadow host id", () => {
    expect(MOO_ELEMENT_IDS.host).toBe("moo-family-bookshelf-host");
  });

  it("keeps the button id in the light DOM", () => {
    expect(MOO_ELEMENT_IDS.button).toBe("moo-family-bookshelf-btn");
  });
});

describe("cleanupMooFamilyUI", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mountFullUi(): { host: HTMLElement; shadow: ShadowRoot } {
    const button = document.createElement("button");
    button.id = MOO_ELEMENT_IDS.button;
    document.body.appendChild(button);

    // The host owns a shadow root that contains backdrop + dialog, mirroring the
    // content script's toggleDialog layout.
    const host = document.createElement("div");
    host.id = MOO_ELEMENT_IDS.host;
    const shadow = host.attachShadow({ mode: "open" });

    const backdrop = document.createElement("div");
    backdrop.id = MOO_ELEMENT_IDS.backdrop;
    const dialog = document.createElement("div");
    dialog.id = MOO_ELEMENT_IDS.dialog;
    shadow.appendChild(backdrop);
    shadow.appendChild(dialog);
    document.body.appendChild(host);

    return { host, shadow };
  }

  it("removes both the floating button and the shadow host", () => {
    mountFullUi();

    cleanupMooFamilyUI();

    expect(document.getElementById(MOO_ELEMENT_IDS.button)).toBeNull();
    expect(document.getElementById(MOO_ELEMENT_IDS.host)).toBeNull();
  });

  it("drops the dialog + backdrop by removing their shadow host", () => {
    const { shadow } = mountFullUi();
    // Sanity: the dialog/backdrop are reachable only via the shadow root.
    expect(shadow.getElementById(MOO_ELEMENT_IDS.dialog)).not.toBeNull();
    expect(shadow.getElementById(MOO_ELEMENT_IDS.backdrop)).not.toBeNull();

    cleanupMooFamilyUI();

    // With the host gone, nothing from the dialog subtree remains attached.
    expect(document.body.querySelector(`#${MOO_ELEMENT_IDS.host}`)).toBeNull();
  });

  it("is a no-op when no MooFamily UI is present", () => {
    expect(() => cleanupMooFamilyUI()).not.toThrow();
  });

  it("removes only MooFamily nodes, leaving page content untouched", () => {
    const pageContent = document.createElement("div");
    pageContent.id = "readmoo-page-content";
    document.body.appendChild(pageContent);
    mountFullUi();

    cleanupMooFamilyUI();

    expect(document.getElementById("readmoo-page-content")).not.toBeNull();
  });
});

describe("isExtensionContextValid", () => {
  it("returns true when the mocked runtime id is present", () => {
    // tests/setup.ts provides a browser mock with runtime.id set.
    expect(isExtensionContextValid()).toBe(true);
  });
});
