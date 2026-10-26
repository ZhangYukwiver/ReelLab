// 页面和拆片工坊本机服务之间的连接：地址校验、配对、带令牌发请求、配对过期自动续配。

/** 配好对的一条连接：服务根地址 + Bearer 令牌 */
export interface Connection {
  baseUrl: string;
  token: string;
}

export class ServerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] !== undefined && parts[1] >= 64 && parts[1] <= 127);
}

export function normalizeServerBaseUrl(value: string): string {
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ServerError("invalid_url", "本机服务地址不完整。");
  }

  const bareHostname = url.hostname.replace(/^\[|\]$/gu, "");
  const localHostname = bareHostname === "localhost" || bareHostname === "127.0.0.1" || bareHostname === "::1";
  const privateHostname = isPrivateIpv4(bareHostname) ||
    bareHostname.endsWith(".local") ||
    /^(?:f[cd]|fe8)[0-9a-f]*:/iu.test(bareHostname);
  if (!(["http:", "https:"].includes(url.protocol) && (localHostname || privateHostname))) {
    throw new ServerError("unsafe_url", "只能连接本机或局域网里的服务。");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ServerError("invalid_url", "服务地址不能带账号、路径、查询参数或片段。");
  }
  return url.toString().replace(/\/$/u, "");
}

/** 浏览器里开发时连的地址；桌面版用外壳给的地址，不走这里 */
export function getDefaultServerBaseUrl(): string {
  return process.env.EXPO_PUBLIC_SERVER_BASE_URL?.trim() || "http://127.0.0.1:4865";
}

// 配对闲置 12 小时会过期（比如电脑睡了一夜）。App 登记续配函数后，请求碰到 not_paired 就重新配对再发一次；
// 还攥着旧令牌的轮询循环发请求时也会换成新令牌
let renewToken: ((expired: string) => Promise<string | null>) | null = null;
const renewedTokens = new Map<string, Promise<string | null>>();

export function setTokenRenewal(renew: ((expired: string) => Promise<string | null>) | null): void {
  renewToken = renew;
  renewedTokens.clear();
}

// 同一个过期令牌只续配一次，并发请求共用结果；续不上就忘掉，下次再试
async function renewAfterExpiry(expired: string): Promise<string | null> {
  if (!renewToken) return null;
  let renewal = renewedTokens.get(expired);
  if (!renewal) {
    renewal = renewToken(expired).catch(() => null);
    renewedTokens.set(expired, renewal);
  }
  const fresh = await renewal;
  if (!fresh) renewedTokens.delete(expired);
  return fresh;
}

async function latestToken(token: string): Promise<string> {
  let current = token;
  for (let next = renewedTokens.get(current); next; next = renewedTokens.get(current)) {
    const renewed = await next;
    if (!renewed) break;
    current = renewed;
  }
  return current;
}

/** 带令牌发请求；配对过期（401 not_paired）就自动续配、用新令牌重发一次。响应由调用方自己解析 */
export async function serverFetch(connection: Connection, path: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string) => fetch(`${normalizeServerBaseUrl(connection.baseUrl)}${path}`, {
    ...init,
    headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${token}` },
  });
  // 没续过配就别多等一拍
  const token = renewedTokens.size ? await latestToken(connection.token) : connection.token;
  const response = await send(token);
  if (response.status !== 401) return response;
  const payload = await response.clone().json().catch(() => null) as unknown;
  const fresh = isObject(payload) && payload.error === "not_paired" ? await renewAfterExpiry(token) : null;
  return fresh ? send(fresh) : response;
}

// 配对前的两个请求（拿配对码、配对）用：不带令牌，10 秒超时
async function requestJson(baseUrl: string, path: string, options: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${normalizeServerBaseUrl(baseUrl)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const errorCode = isObject(payload) && typeof payload.error === "string" ? payload.error : `http_${response.status}`;
      const serverMessage = isObject(payload) && typeof payload.message === "string" && payload.message.trim() ? payload.message : null;
      const message = errorCode === "invalid_pairing_code" ? "配对码无效或已经用过了。"
        : errorCode === "pairing_code_local_only" ? "只有这台电脑上的页面能自动配对。"
        : serverMessage ?? `本机服务请求失败（${response.status}）。`;
      throw new ServerError(errorCode, message);
    }
    return payload;
  } catch (error) {
    if (error instanceof ServerError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ServerError("timeout", "连接本机服务超时。");
    throw new ServerError("unreachable", "连不上本机服务，请确认拆片工坊开着。");
  } finally {
    clearTimeout(timeout);
  }
}

/** 服务只给本机页面发配对码；桌面版外壳直接给，不用这一步 */
export async function getPairingCode(baseUrl: string): Promise<string> {
  const value = await requestJson(baseUrl, "/v1/pairing-code");
  if (!isObject(value) || typeof value.code !== "string" || !/^\d{8}$/u.test(value.code)) {
    throw new ServerError("invalid_response", "本机服务没给出有效的配对码。");
  }
  return value.code;
}

export async function pairServer(baseUrl: string, code: string): Promise<string> {
  if (!/^\d{8}$/u.test(code.trim())) throw new ServerError("invalid_code", "配对码应为 8 位数字。");
  const value = await requestJson(baseUrl, "/v1/pair", {
    method: "POST",
    body: JSON.stringify({ code: code.trim() }),
  });
  if (!isObject(value) || typeof value.token !== "string" || value.token.length < 32) {
    throw new ServerError("invalid_response", "本机服务没给出有效的会话。");
  }
  return value.token;
}

/** 配一次对：桌面版用外壳给的地址和配对码（desktop），浏览器里开发时先向 fallbackUrl 上的服务要配对码 */
export async function connectServer(desktop: { baseUrl: string; pairingCode: string } | null, fallbackUrl = getDefaultServerBaseUrl()): Promise<Connection> {
  const baseUrl = normalizeServerBaseUrl(desktop?.baseUrl ?? fallbackUrl);
  const token = await pairServer(baseUrl, desktop?.pairingCode ?? await getPairingCode(baseUrl));
  return { baseUrl, token };
}
