import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { USER1 } from "../helpers/ids";
import {
  DEFAULT_MAX_BODY_SIZE,
  PUT_BOOKS_MAX_BODY_SIZE,
} from "../../src/utils/bodyLimit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Issue #361: when a request arrived without a Content-Length header, the
 * `/api/*` body-size guard in `index.ts` did `c.req.raw.clone().arrayBuffer()`
 * — it buffered the WHOLE body in Worker memory before comparing its size to
 * the limit, so an 8MB (or 100MB, Cloudflare's edge cap) chunked upload was
 * read to the end just to be refused. The guard now hands a length-less body
 * to `hono/body-limit`, which counts the body as it streams and answers 413 as
 * soon as the running total passes the limit.
 *
 * Why bytes pulled is the assertion: the status code alone cannot tell the two
 * implementations apart — both answer 413 for an 8MB body. What changed is how
 * much of the body is READ before answering, so every streamed request here
 * carries a counting `ReadableStream` (`countedStream`) whose `pull` adds each
 * enqueued chunk to `pulled`. The bound is "limit + 2 chunks": the reader
 * stops one chunk past the limit, and the stream may have queued one more
 * ahead of the read (its default high-water mark is one chunk). The old
 * buffering guard pulls all of `TOTAL`.
 *
 * GET / HEAD exemption: a length-less GET or HEAD is passed through without
 * reading the body. It is not stream-tested here: undici refuses to build a GET
 * or HEAD Request that carries a body, so no such request can reach the guard
 * in-process. DELETE is NOT exempt: since #396 `DELETE /api/user/:id` reads a
 * JSON body, so a length-less DELETE is counted like a POST (case below).
 *
 * Header branch: a PRESENT Content-Length is still decided from the header
 * alone, for every method — an oversized value is 413 even on GET / DELETE, and
 * a non-numeric one (empty included) is refused fail-closed before any read.
 * A stream is pulled once when it is constructed (to fill its one-chunk
 * queue), so "refused before any read" means `pulled <= CHUNK`.
 *
 * Stream requests and `duplex`: undici requires `duplex: "half"` for a stream
 * body, but `worker/tsconfig.json` types only `@cloudflare/workers-types`,
 * whose `RequestInit` has no `duplex` field — hence `StreamingInit`.
 */

/** Size of each chunk the counting stream enqueues. */
const CHUNK = 64 * 1024;
/** Total body the counting stream can produce — far above either limit. */
const TOTAL = 8 * 1024 * 1024;

type StreamingInit = RequestInit & { duplex: "half" };

interface CountedStream {
  stream: ReadableStream<Uint8Array>;
  /** Bytes the stream has produced so far (i.e. how much was read). */
  pulled: () => number;
}

/** An 8MB body produced on demand, counting every byte handed out.
 *  See the header → "Why bytes pulled is the assertion". */
function countedStream(): CountedStream {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= TOTAL) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(CHUNK).fill(0x78);
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { stream, pulled: () => pulled };
}

function buildRequest(
  method: string,
  path: string,
  body: ReadableStream<Uint8Array> | string | undefined,
  headers: Record<string, string> = {},
): Request {
  const init: StreamingInit = { method, headers, body, duplex: "half" };
  return new Request(`http://localhost${path}`, init as RequestInit);
}

let kv: KVNamespace;

function send(req: Request): Promise<Response> {
  // DEV_MODE bypasses the rate limits; the body guard runs regardless.
  return Promise.resolve(
    app.request(req, undefined, { KV: kv, DEV_MODE: "1" }),
  );
}

async function expect413(res: Response, message: string): Promise<void> {
  expect(res.status).toBe(413);
  const json = (await res.json()) as Json;
  expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
  expect(json.error.message).toBe(message);
}

const MEMBER_PATH = `/api/family/abcd-efgh/member/${USER1}`;

beforeEach(() => {
  kv = createMockKV();
});

describe("/api/* body guard — length-less body is counted, not buffered (#361)", () => {
  it("refuses an 8MB streamed POST after reading only just past 256KB", async () => {
    const counted = countedStream();

    const res = await send(buildRequest("POST", "/api/family", counted.stream));

    await expect413(res, "Request body exceeds 256KB limit");
    expect(counted.pulled()).toBeLessThanOrEqual(
      DEFAULT_MAX_BODY_SIZE + 2 * CHUNK,
    );
  });

  it("refuses an 8MB streamed PUT books after reading only just past 2MB", async () => {
    const token = await seedAuthToken(kv, USER1);
    const counted = countedStream();

    const res = await send(
      buildRequest("PUT", `/api/user/${USER1}/books`, counted.stream, {
        Authorization: `Bearer ${token}`,
      }),
    );

    await expect413(res, "Request body exceeds 2MB limit");
    expect(counted.pulled()).toBeLessThanOrEqual(
      PUT_BOOKS_MAX_BODY_SIZE + 2 * CHUNK,
    );
  });

  it("refuses an 8MB streamed DELETE after reading only just past 256KB (#396 made DELETE carry a body)", async () => {
    // See the header → "GET / HEAD exemption": DELETE is measured, not exempt.
    const counted = countedStream();

    const res = await send(buildRequest("DELETE", MEMBER_PATH, counted.stream));

    await expect413(res, "Request body exceeds 256KB limit");
    expect(counted.pulled()).toBeLessThanOrEqual(
      DEFAULT_MAX_BODY_SIZE + 2 * CHUNK,
    );
  });
});

describe("/api/* body guard — Content-Length header branch", () => {
  const oversized = { "Content-Length": String(DEFAULT_MAX_BODY_SIZE + 1) };

  it("refuses a GET whose Content-Length is over 256KB", async () => {
    const res = await send(
      buildRequest("GET", "/api/version", undefined, oversized),
    );

    await expect413(res, "Request body exceeds 256KB limit");
  });

  it("refuses a DELETE whose Content-Length is over 256KB", async () => {
    const res = await send(
      buildRequest("DELETE", MEMBER_PATH, "{}", oversized),
    );

    await expect413(res, "Request body exceeds 256KB limit");
  });

  it("refuses an empty Content-Length fail-closed before reading the body", async () => {
    const counted = countedStream();

    const res = await send(
      buildRequest("POST", "/api/family", counted.stream, {
        "Content-Length": "",
      }),
    );

    await expect413(res, "Request body exceeds 256KB limit");
    expect(counted.pulled()).toBeLessThanOrEqual(CHUNK);
  });
});
