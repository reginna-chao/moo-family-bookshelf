import { createKvClient } from "../../../scripts/kv-backup/api.mjs";
import { ACCOUNT, SOURCE, NOW } from "../helpers/kvBackupFixtures";

/** Native Response bodies exercise the actual REST decoder. No test reaches
 * Cloudflare; the injected transport pins request contracts and retry budgets. */
function response(result: unknown, extra = {}) {
  return new Response(
    JSON.stringify({ success: true, errors: [], result, ...extra }),
  );
}

function setup(fetchImpl: typeof fetch) {
  const sleeps: number[] = [];
  const client = createKvClient({
    accountId: ACCOUNT,
    namespaceId: SOURCE,
    token: "private-token",
    fetchImpl,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, sleeps };
}

describe("KV backup REST adapter", () => {
  it("requests text and metadata, preserving nulls and cursor encoding", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([{ name: "user:a" }], { result_info: { cursor: "next+/=" } }),
      )
      .mockResolvedValueOnce(response([], { result_info: { cursor: "" } }))
      .mockResolvedValueOnce(
        response({
          values: {
            "user:a": {
              value: '{ "x": "書📚" }',
              expiration: 1900000000,
              metadata: { tag: "a" },
            },
            "user:b": null,
          },
        }),
      );
    const { client } = setup(transport);
    expect(await client.listKeys()).toEqual([{ name: "user:a" }]);
    expect(String(transport.mock.calls[1][0])).toContain(
      "cursor=next%2B%2F%3D",
    );
    const values = await client.readKeys(["user:a", "user:b"]);
    expect(values["user:b"]).toBeNull();
    expect(values["user:a"]).toEqual({
      value: '{ "x": "書📚" }',
      expiration: 1900000000,
      metadata: { tag: "a" },
    });
    const init = transport.mock.calls[2][1];
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init?.body))).toEqual({
      keys: ["user:a", "user:b"],
      type: "text",
      withMetadata: true,
    });
    expect(init?.headers).toEqual({
      Authorization: "Bearer private-token",
      "Content-Type": "application/json",
    });
    expect(init?.signal).toBeDefined();
  });

  it("splits HTTP 413 bulk reads and combines both halves", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("large", { status: 413 }))
      .mockResolvedValueOnce(
        response({ values: { "user:a": { value: "{}" } } }),
      )
      .mockResolvedValueOnce(
        response({ values: { "user:b": { value: "{}" } } }),
      );
    const { client } = setup(transport);
    expect(Object.keys(await client.readKeys(["user:a", "user:b"]))).toEqual([
      "user:a",
      "user:b",
    ]);
    expect(
      transport.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).keys,
      ),
    ).toEqual([["user:a", "user:b"], ["user:a"], ["user:b"]]);
  });

  it("honors Retry-After on 429 and then accepts success", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("private body", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(response([], { result_info: { cursor: "" } }));
    const { client, sleeps } = setup(transport);
    expect(await client.listKeys()).toEqual([]);
    expect(sleeps).toContain(2000);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("bounds connection timeout retries and redacts transport details", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("secret-user-key private-token"));
    const { client } = setup(transport);
    await expect(client.listKeys()).rejects.toThrow("逾時");
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it.each([429, 500])("never retries a failed PUT (%s)", async (status) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private-key", { status }));
    const { client } = setup(transport);
    await expect(
      client.writeRecords([{ key: "user:a", value: "{}" }]),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    { successful_key_count: 0, unsuccessful_keys: ["user:a"] },
    { successful_key_count: 1, unsuccessful_keys: ["user:a"] },
    { successful_key_count: 1 },
  ])("rejects incomplete HTTP 200 write results: %j", async (result) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response(result));
    await expect(
      setup(transport).client.writeRecords([{ key: "user:a", value: "{}" }]),
    ).rejects.toThrow("未完整成功");
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(["cursor", "duplicate", "missing-page-info"])(
    "rejects malformed pagination: %s",
    async (kind) => {
      const first = response([{ name: "user:a" }], {
        result_info: { cursor: "next" },
      });
      const second =
        kind === "missing-page-info"
          ? response([])
          : response(kind === "duplicate" ? [{ name: "user:a" }] : [], {
              result_info: { cursor: kind === "cursor" ? "next" : "" },
            });
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      await expect(setup(transport).client.listKeys()).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["false", "errors", "malformed"])(
    "fails closed on invalid envelopes: %s",
    async (kind) => {
      const payload =
        kind === "malformed"
          ? new Response("broken")
          : response([], {
              success: kind !== "false",
              errors: kind === "errors" ? [{ message: "private" }] : [],
            });
      const transport = vi.fn<typeof fetch>().mockResolvedValue(payload);
      await expect(setup(transport).client.listKeys()).rejects.toThrow();
    },
  );
});
