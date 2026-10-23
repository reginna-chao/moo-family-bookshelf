/** CDP driver for the Dialog's CLOSED shadow root, which Playwright locators cannot pierce: reads and
 *  clicks inside it through the DevTools protocol. See `createClosedShadowDriver`. */

import type { CDPSession, Page } from "@playwright/test";

const OBJECT_GROUP = "moo-closed-shadow-driver";
const POLL_MS = 250;

/** The subset of a CDP `DOM.Node` this driver walks. */
interface CdpNode {
  nodeId: number;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  shadowRootType?: string;
  contentDocument?: CdpNode;
}

/** An element inside the shadow root: the first `selector` match whose textContent includes `text`. */
export interface ElementQuery {
  selector: string;
  text?: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface StableCenterOptions {
  samples?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface ClosedShadowDriver {
  /** `shadowRootType` CDP reports for the host's root ("open" / "closed"), or null without a host. */
  rootType(): Promise<string | null>;
  exists(query: ElementQuery): Promise<boolean>;
  /** Polls until `query` matches; throws with the root's text after `timeoutMs`. */
  waitFor(query: ElementQuery, timeoutMs?: number): Promise<void>;
  text(query: ElementQuery): Promise<string>;
  /** Scrolls the element into view, then returns its viewport centre (CSS px). */
  center(query: ElementQuery): Promise<Point>;
  /** `center()`, then waits until `samples` consecutive readings `intervalMs` apart agree (the first is
   *  that scrolled one), so a layout still settling (async content above) is waited out, not raced. */
  stableCenter(query: ElementQuery, opts?: StableCenterOptions): Promise<Point>;
  /** A real mouse click (`page.mouse`) at the element's centre. */
  click(query: ElementQuery): Promise<void>;
  /** Runs `fn` with `this` = the shadow root and returns its JSON result. */
  evaluate<T>(fn: string, ...args: unknown[]): Promise<T>;
  dispose(): Promise<void>;
}

// Shared lookup, inlined into every function sent through Runtime.callFunctionOn.
const FIND_ELEMENT = `(root, selector, text) => Array.from(root.querySelectorAll(selector))
  .find((el) => text === undefined || text === null || (el.textContent ?? "").includes(text)) ?? null`;

function findHost(node: CdpNode, hostId: string): CdpNode | null {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === "id" && attrs[i + 1] === hostId) return node;
  }
  const next = [
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
    ...(node.contentDocument ? [node.contentDocument] : []),
  ];
  for (const child of next) {
    const found = findHost(child, hostId);
    if (found) return found;
  }
  return null;
}

/**
 * Ground-truth access to the Dialog's closed shadow root for E2E. `DOM.getDocument({ pierce: true })`
 * returns closed roots too; the root is resolved to a remote object and the work runs through
 * `Runtime.callFunctionOn` with `this` bound to it — DevTools privilege, never reachable from a page
 * script, so the isolation spec can use it as the truth it compares the main world against.
 * The document is re-fetched on every call (node ids go stale after React re-renders) and each call's
 * remote objects are released before it returns. `dispose()` detaches the CDP session.
 */
export async function createClosedShadowDriver(
  page: Page,
  hostId: string,
): Promise<ClosedShadowDriver> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");

  async function shadowRootNode(): Promise<CdpNode | null> {
    const { root } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const host = findHost(root as CdpNode, hostId);
    return host?.shadowRoots?.[0] ?? null;
  }

  async function evaluate<T>(fn: string, ...args: unknown[]): Promise<T> {
    const rootNode = await shadowRootNode();
    if (!rootNode) throw new Error(`#${hostId} has no shadow root yet`);
    try {
      const { object } = await cdp.send("DOM.resolveNode", {
        nodeId: rootNode.nodeId,
        objectGroup: OBJECT_GROUP,
      });
      const { result, exceptionDetails } = await cdp.send(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          functionDeclaration: fn,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
        },
      );
      if (exceptionDetails) {
        throw new Error(
          `closed-shadow evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
        );
      }
      return result.value as T;
    } finally {
      await cdp.send("Runtime.releaseObjectGroup", {
        objectGroup: OBJECT_GROUP,
      });
    }
  }

  const exists = (q: ElementQuery) =>
    evaluate<boolean>(
      `function (selector, text) { return (${FIND_ELEMENT})(this, selector, text) !== null; }`,
      q.selector,
      q.text ?? null,
    ).catch(() => false);

  async function text(q: ElementQuery): Promise<string> {
    const value = await evaluate<string | null>(
      `function (selector, text) { const el = (${FIND_ELEMENT})(this, selector, text); return el ? el.textContent : null; }`,
      q.selector,
      q.text ?? null,
    );
    if (value === null) throw new Error(`no match for ${JSON.stringify(q)}`);
    return value;
  }

  async function measure(q: ElementQuery, scroll: boolean): Promise<Point> {
    const point = await evaluate<Point | null>(
      `function (selector, text, scroll) {
        const el = (${FIND_ELEMENT})(this, selector, text);
        if (!el) return null;
        if (scroll) el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }`,
      q.selector,
      q.text ?? null,
      scroll,
    );
    if (!point) throw new Error(`no match for ${JSON.stringify(q)}`);
    return point;
  }

  const center = (q: ElementQuery) => measure(q, true);

  // Samples WITHOUT scrolling: re-centring on every reading would hide the very shift it looks for.
  async function stableCenter(
    q: ElementQuery,
    {
      samples = 3,
      intervalMs = POLL_MS,
      timeoutMs = 5_000,
    }: StableCenterOptions = {},
  ): Promise<Point> {
    const deadline = Date.now() + timeoutMs;
    let anchor = await center(q);
    let streak = 1;
    while (streak < samples) {
      if (Date.now() > deadline) {
        throw new Error(
          `closed-shadow stableCenter: ${JSON.stringify(q)} still moving after ${timeoutMs} ms (last ${JSON.stringify(anchor)})`,
        );
      }
      await page.waitForTimeout(intervalMs);
      const next = await measure(q, false);
      if (next.x === anchor.x && next.y === anchor.y) {
        streak += 1;
      } else {
        anchor = await center(q);
        streak = 1;
      }
    }
    return anchor;
  }

  async function waitFor(q: ElementQuery, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await exists(q)) return;
      await page.waitForTimeout(POLL_MS);
    }
    const rootText = await evaluate<string>(
      "function () { return this.textContent; }",
    ).catch((e: unknown) => `(unreadable: ${String(e)})`);
    throw new Error(
      `closed-shadow waitFor timed out on ${JSON.stringify(q)}.\nRoot text: ${rootText}`,
    );
  }

  return {
    rootType: async () => (await shadowRootNode())?.shadowRootType ?? null,
    exists,
    waitFor,
    text,
    center,
    stableCenter,
    click: async (q) => {
      const { x, y } = await center(q);
      await page.mouse.click(x, y);
    },
    evaluate,
    dispose: () => cdp.detach(),
  };
}
