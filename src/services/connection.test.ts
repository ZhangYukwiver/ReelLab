import { afterEach, describe, expect, it, vi } from "vitest";

import { connectServer, normalizeServerBaseUrl, serverFetch, setTokenRenewal } from "./connection";

afterEach(() => {
  vi.unstubAllGlobals();
  setTokenRenewal(null);
});

const TOKEN = "t".repeat(43);

/** 记下每次请求的方法、地址、令牌和请求体，按 reply 回 */
function stubFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method: init.method ?? "GET", url, auth: headers.Authorization ?? null, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return reply(url, init);
  }));
  return calls;
}

describe("normalizeServerBaseUrl", () => {
  it("takes this computer and the local network, drops the trailing slash", () => {
    expect(normalizeServerBaseUrl(" http://127.0.0.1:4865/ ")).toBe("http://127.0.0.1:4865");
    expect(normalizeServerBaseUrl("http://localhost:4865")).toBe("http://localhost:4865");
    expect(normalizeServerBaseUrl("http://[::1]:4865")).toBe("http://[::1]:4865");
    expect(normalizeServerBaseUrl("http://192.168.1.20:4865")).toBe("http://192.168.1.20:4865");
  });

  it("refuses public hosts, paths, queries and credentials", () => {
    expect(() => normalizeServerBaseUrl("https://example.com")).toThrow(expect.objectContaining({ code: "unsafe_url" }));
    expect(() => normalizeServerBaseUrl("http://127.0.0.1:4865/v1")).toThrow(expect.objectContaining({ code: "invalid_url" }));
    expect(() => normalizeServerBaseUrl("http://127.0.0.1:4865/?a=1")).toThrow(expect.objectContaining({ code: "invalid_url" }));
    expect(() => normalizeServerBaseUrl("http://u:p@127.0.0.1:4865")).toThrow(expect.objectContaining({ code: "invalid_url" }));
    expect(() => normalizeServerBaseUrl("不是地址")).toThrow(expect.objectContaining({ code: "invalid_url" }));
  });
});

describe("connectServer", () => {
  it("pairs with the code the desktop shell hands over, without asking the server for one", async () => {
    const calls = stubFetch(() => Response.json({ token: TOKEN }));
    expect(await connectServer({ baseUrl: "http://127.0.0.1:51234", pairingCode: "12345678" })).toEqual({ baseUrl: "http://127.0.0.1:51234", token: TOKEN });
    expect(calls).toEqual([{ method: "POST", url: "http://127.0.0.1:51234/v1/pair", auth: null, body: { code: "12345678" } }]);
  });

  it("in a browser asks the local server for a pairing code first, at the default port", async () => {
    const calls = stubFetch((url) => Response.json(url.endsWith("/v1/pairing-code") ? { code: "87654321" } : { token: TOKEN }));
    expect(await connectServer(null)).toEqual({ baseUrl: "http://127.0.0.1:4865", token: TOKEN });
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual(["GET http://127.0.0.1:4865/v1/pairing-code", "POST http://127.0.0.1:4865/v1/pair"]);
    expect(calls[1]!.body).toEqual({ code: "87654321" });
  });

  it("says plainly when the server is not running or the code was refused", async () => {
    stubFetch(() => { throw new TypeError("Failed to fetch"); });
    await expect(connectServer(null)).rejects.toMatchObject({ code: "unreachable", message: "连不上本机服务，请确认拆片工坊开着。" });
    stubFetch(() => Response.json({ error: "invalid_pairing_code" }, { status: 403 }));
    await expect(connectServer({ baseUrl: "http://127.0.0.1:51234", pairingCode: "12345678" })).rejects.toMatchObject({ code: "invalid_pairing_code", message: "配对码无效或已经用过了。" });
    stubFetch(() => Response.json({ error: "pairing_code_local_only" }, { status: 403 }));
    await expect(connectServer(null)).rejects.toMatchObject({ code: "pairing_code_local_only" });
  });
});

describe("serverFetch", () => {
  it("sends the bearer token and leaves other answers to the caller", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }, { status: 404 }));
    const response = await serverFetch({ baseUrl: "http://127.0.0.1:4865/", token: "old" }, "/v1/analyses");
    expect(response.status).toBe(404);
    expect(calls).toEqual([{ method: "GET", url: "http://127.0.0.1:4865/v1/analyses", auth: "Bearer old", body: undefined }]);
  });

  it("re-pairs once when the pairing expired and resends with the new token; parallel requests share that one renewal", async () => {
    const calls = stubFetch((_url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer fresh" ? Response.json({ ok: true }) : Response.json({ error: "not_paired" }, { status: 401 });
    });
    const renew = vi.fn(async () => "fresh");
    setTokenRenewal(renew);
    const [first, second] = await Promise.all([
      serverFetch({ baseUrl: "http://127.0.0.1:4865", token: "old" }, "/v1/a"),
      serverFetch({ baseUrl: "http://127.0.0.1:4865", token: "old" }, "/v1/b"),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith("old");
    // 之后还攥着旧令牌的请求直接换成新的，不再碰一次 401
    calls.length = 0;
    await serverFetch({ baseUrl: "http://127.0.0.1:4865", token: "old" }, "/v1/c");
    expect(calls.map((call) => call.auth)).toEqual(["Bearer fresh"]);
  });

  it("hands back the 401 when there is nothing to renew with or renewal failed", async () => {
    stubFetch(() => Response.json({ error: "not_paired" }, { status: 401 }));
    expect((await serverFetch({ baseUrl: "http://127.0.0.1:4865", token: "old" }, "/v1/a")).status).toBe(401);
    setTokenRenewal(async () => null);
    expect((await serverFetch({ baseUrl: "http://127.0.0.1:4865", token: "old" }, "/v1/a")).status).toBe(401);
  });
});
