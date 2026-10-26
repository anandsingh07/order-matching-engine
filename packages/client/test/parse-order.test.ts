import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePlainEnglish } from "../src/index.js";

// The plain-English endpoint as a session sees it. fetch is replaced (this
// package has no Node types, so no real server): each test decides what the
// "gateway" answers and checks what was asked.

let calls: { url: string; init: RequestInit }[] = [];

function gateway(answer: (init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(init);
  });
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePlainEnglish", () => {
  const proposal = {
    kind: "order",
    symbol: "TCS",
    order: { type: "limit", side: "buy", price: 410000, quantity: 10, timeInForce: "GTC" },
    summary: "Buy 10 TCS at 4100.00 INR (limit, good till cancelled)",
    warnings: [],
    fields: {},
    source: "rules",
    latencyMs: 0.4,
  };

  it("sends the session token as a bearer token and only the text (and mode, when asked)", async () => {
    gateway(() => json(200, proposal));
    expect(await parsePlainEnglish("http://gw", "tok-1", "buy 10 tcs at 4100")).toEqual(proposal);
    expect(calls[0]!.url).toBe("http://gw/api/parse-order");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer tok-1" });
    expect(calls[0]!.init.body).toBe(JSON.stringify({ text: "buy 10 tcs at 4100" }));
    await parsePlainEnglish("http://gw", "tok-1", "buy 10 tcs", { mode: "rules" });
    expect(calls[1]!.init.body).toBe(JSON.stringify({ text: "buy 10 tcs", mode: "rules" }));
  });

  it("returns the parser's error answer as it is", async () => {
    const error = { kind: "error", message: "the request was cancelled", latencyMs: 3 };
    gateway(() => json(503, error));
    expect(await parsePlainEnglish("http://gw", "t", "buy")).toEqual(error);
  });

  it("reports what stopped a request before the parser", async () => {
    gateway(() => json(401, { error: "unknown session token" }));
    expect(await parsePlainEnglish("http://gw", "t", "buy")).toEqual({ kind: "failed", status: 401, message: "unknown session token" });
    gateway(() => new Response("not found", { status: 404 }));
    expect(await parsePlainEnglish("http://gw", "t", "buy")).toEqual({ kind: "failed", status: 404, message: "HTTP 404" });
    // Retry-After in seconds, unless the body says exactly.
    gateway(() => json(429, { error: "rate_limited" }, { "retry-after": "2" }));
    expect(await parsePlainEnglish("http://gw", "t", "buy")).toEqual({ kind: "failed", status: 429, message: "rate_limited", retryAfterMs: 2000 });
    gateway(() => json(429, { error: "rate_limited", retryAfterMs: 400 }, { "retry-after": "1" }));
    expect(await parsePlainEnglish("http://gw", "t", "buy")).toMatchObject({ retryAfterMs: 400 });
    gateway(() => {
      throw new TypeError("fetch failed");
    });
    expect(await parsePlainEnglish("http://gw", "t", "buy")).toEqual({ kind: "failed", status: null, message: "cannot reach the gateway" });
  });

  it("rethrows a cancel, so the caller can tell it from a failure", async () => {
    gateway((init) => {
      init.signal?.throwIfAborted();
      return json(200, proposal);
    });
    const controller = new AbortController();
    controller.abort();
    await expect(parsePlainEnglish("http://gw", "t", "buy", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
