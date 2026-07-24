import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, cpSync } from "fs";
import { devManifest } from "../../plugins/devManifest";

vi.mock("fs", () => {
  const mocks = {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    cpSync: vi.fn(),
  };
  return { ...mocks, default: mocks };
});

type PluginHooks = {
  configResolved: (config: { mode: string; build: { outDir: string } }) => void;
  closeBundle: () => void;
};

function setupPlugin(mode: string, outDir = "dist"): PluginHooks {
  const plugin = devManifest();
  const hooks = plugin as unknown as PluginHooks;
  hooks.configResolved({ mode, build: { outDir } });
  return hooks;
}

function lastWrittenManifest(): Record<string, unknown> {
  const calls = vi.mocked(writeFileSync).mock.calls;
  return JSON.parse(String(calls[calls.length - 1][1])) as Record<
    string,
    unknown
  >;
}

const PROD_MANIFEST = JSON.stringify({
  name: "墨家書櫃 | MooFamily Bookshelf",
  icons: {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_icon: {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
});

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

describe("devManifest", () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(cpSync).mockReset();
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  it("does not modify manifest when mode is production", () => {
    const hooks = setupPlugin("production");
    hooks.closeBundle();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(cpSync).not.toHaveBeenCalled();
  });

  it("appends (dev) suffix when mode is remote", () => {
    vi.mocked(readFileSync).mockReturnValue(PROD_MANIFEST as never);
    const hooks = setupPlugin("remote");
    hooks.closeBundle();
    expect(lastWrittenManifest().name).toBe(
      "墨家書櫃 | MooFamily Bookshelf (dev)",
    );
  });

  it("appends (local) suffix when mode is development", () => {
    vi.mocked(readFileSync).mockReturnValue(PROD_MANIFEST as never);
    const hooks = setupPlugin("development");
    hooks.closeBundle();
    expect(lastWrittenManifest().name).toBe(
      "墨家書櫃 | MooFamily Bookshelf (local)",
    );
  });

  it("keeps a single (dev) suffix after consecutive closeBundle calls", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(PROD_MANIFEST as never);
    const hooks = setupPlugin("remote");
    hooks.closeBundle();

    const firstWritten = String(vi.mocked(writeFileSync).mock.calls[0][1]);
    vi.mocked(readFileSync).mockReturnValueOnce(firstWritten as never);
    hooks.closeBundle();

    const manifest = lastWrittenManifest();
    expect(manifest.name).toBe("墨家書櫃 | MooFamily Bookshelf (dev)");
    expect(((manifest.name as string).match(/\(dev\)/g) ?? []).length).toBe(1);
  });

  it("replaces (local) with (dev) when variant switches", () => {
    const localManifest = JSON.stringify({
      name: "墨家書櫃 | MooFamily Bookshelf (local)",
      icons: { "16": "icons/icon-16.png" },
    });
    vi.mocked(readFileSync).mockReturnValue(localManifest as never);
    const hooks = setupPlugin("remote");
    hooks.closeBundle();
    expect(lastWrittenManifest().name).toBe(
      "墨家書櫃 | MooFamily Bookshelf (dev)",
    );
  });

  it("rewrites both manifest.icons and action.default_icon", () => {
    vi.mocked(readFileSync).mockReturnValue(PROD_MANIFEST as never);
    const hooks = setupPlugin("remote");
    hooks.closeBundle();
    const manifest = lastWrittenManifest();

    const icons = manifest.icons as Record<string, string>;
    expect(icons["16"]).toBe("icons-dev/icon-16.png");
    expect(icons["48"]).toBe("icons-dev/icon-48.png");
    expect(icons["128"]).toBe("icons-dev/icon-128.png");

    const action = manifest.action as { default_icon: Record<string, string> };
    expect(action.default_icon["16"]).toBe("icons-dev/icon-16.png");
    expect(action.default_icon["48"]).toBe("icons-dev/icon-48.png");
    expect(action.default_icon["128"]).toBe("icons-dev/icon-128.png");
  });

  it("does not throw when manifest has no action field", () => {
    const noActionManifest = JSON.stringify({
      name: "X",
      icons: { "16": "icons/icon-16.png" },
    });
    vi.mocked(readFileSync).mockReturnValue(noActionManifest as never);
    const hooks = setupPlugin("remote");
    expect(() => hooks.closeBundle()).not.toThrow();

    const icons = lastWrittenManifest().icons as Record<string, string>;
    expect(icons["16"]).toBe("icons-dev/icon-16.png");
  });

  it("warns and skips icons not prefixed with icons/", () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const customManifest = JSON.stringify({
      name: "X",
      icons: { "16": "custom/icon-16.png" },
    });
    vi.mocked(readFileSync).mockReturnValue(customManifest as never);
    const hooks = setupPlugin("remote");
    hooks.closeBundle();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("custom/icon-16.png"),
    );

    const icons = lastWrittenManifest().icons as Record<string, string>;
    expect(icons["16"]).toBe("custom/icon-16.png");
  });

  it("warns and preserves already-rewritten icon paths", () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rewrittenManifest = JSON.stringify({
      name: "X (dev)",
      icons: { "16": "icons-dev/icon-16.png" },
    });
    vi.mocked(readFileSync).mockReturnValue(rewrittenManifest as never);
    const hooks = setupPlugin("remote");
    hooks.closeBundle();

    expect(warnSpy).toHaveBeenCalledOnce();

    const manifest = lastWrittenManifest();
    expect(manifest.name).toBe("X (dev)");
    expect((manifest.icons as Record<string, string>)["16"]).toBe(
      "icons-dev/icon-16.png",
    );
  });

  it("returns early when manifest.json cannot be read", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const hooks = setupPlugin("remote");
    expect(() => hooks.closeBundle()).not.toThrow();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(cpSync).not.toHaveBeenCalled();
  });

  it("warns but continues when cpSync fails", () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(readFileSync).mockReturnValue(PROD_MANIFEST as never);
    vi.mocked(cpSync).mockImplementation(() => {
      throw new Error("EPERM");
    });
    const hooks = setupPlugin("remote");
    hooks.closeBundle();

    expect(writeFileSync).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("icons-dev"));
  });
});
