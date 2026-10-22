// Minimal client for Garmin's official Connect Personal API.
//
// Auth is two steps: the long-lived personal API key is exchanged for a
// 24-hour access token (a JWT), which is sent as a bearer token on every data
// request. There are no refresh tokens; the key is simply exchanged again.

import type { Env } from "./env";

const DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const TOKEN_KV_KEY = "garmin:access-token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const FALLBACK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

export class GarminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GarminError";
  }
}

interface CachedToken {
  value: string;
  expiresAt: number; // epoch ms
}

// Per-isolate cache. Workers reuse isolates between requests, so this saves a
// key exchange most of the time; KV covers cold starts.
let memoryToken: (CachedToken & { keyId: string }) | null = null;
let inflightExchange: Promise<CachedToken> | null = null;

type Query = Record<string, string | number | boolean | undefined | null>;

export class GarminClient {
  private readonly baseUrl: string;

  constructor(private readonly env: Env) {
    if (!env.GARMIN_API_KEY || !env.GARMIN_API_KEY.trim()) {
      throw new GarminError(
        "The connector has no Garmin API key. Run `npx wrangler secret put GARMIN_API_KEY` and paste your Personal API key.",
      );
    }
    this.baseUrl = (env.GARMIN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /** GET a Personal API path and return parsed JSON, or null for an empty response. */
  async get<T = unknown>(path: string, query: Query = {}): Promise<T | null> {
    const url = this.url(path, query);
    let token = await this.token();
    let response = await this.send(url, token.value);
    if (response.status === 401) {
      // The token may have been revoked early (for example the key was rotated).
      await this.forgetToken();
      token = await this.token();
      response = await this.send(url, token.value);
    }
    if (response.status === 204) return null;
    if (!response.ok) throw await this.statusError(response, path);
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GarminError(`Garmin returned a response for ${path} that is not JSON.`);
    }
  }

  private url(path: string, query: Query): string {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || path.includes("..")) {
      throw new GarminError("The path must be an absolute API path such as /sleep-service/sleep/dailySleep.");
    }
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.append(name, String(value));
    }
    return url.toString();
  }

  private async send(url: string, token: string): Promise<Response> {
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GarminError(`Could not reach Garmin (${describe(error)}). Try again in a moment.`);
    }
  }

  private async statusError(response: Response, path: string): Promise<GarminError> {
    const status = response.status;
    let detail = "";
    try {
      detail = (await response.text()).trim().slice(0, 300);
    } catch {
      // ignore
    }
    const suffix = detail ? ` Garmin said: ${detail}` : "";
    if (status === 400) {
      return new GarminError(`Garmin rejected the request for ${path} (HTTP 400). Check the dates and parameters; some endpoints only accept short date ranges.${suffix}`, status);
    }
    if (status === 403) return new GarminError(`Garmin does not allow this key to read ${path} (HTTP 403).${suffix}`, status);
    if (status === 404) return new GarminError(`Garmin has nothing at ${path} (HTTP 404).${suffix}`, status);
    if (status === 429) {
      const wait = response.headers.get("Retry-After");
      return new GarminError(`Garmin is rate-limiting requests (HTTP 429)${wait ? `; retry after ${wait} seconds` : ""}.`, status);
    }
    if (status >= 500) return new GarminError(`Garmin had a server error for ${path} (HTTP ${status}). Try a shorter date range or try again later.${suffix}`, status);
    return new GarminError(`Garmin returned HTTP ${status} for ${path}.${suffix}`, status);
  }

  // ---- access tokens --------------------------------------------------------

  private async token(): Promise<CachedToken> {
    const keyId = await this.keyId();
    const now = Date.now();
    if (memoryToken && memoryToken.keyId === keyId && memoryToken.expiresAt - now > REFRESH_MARGIN_MS) {
      return memoryToken;
    }
    const stored = await this.loadStoredToken();
    if (stored && stored.expiresAt - now > REFRESH_MARGIN_MS) {
      memoryToken = { ...stored, keyId };
      return stored;
    }
    if (!inflightExchange) {
      inflightExchange = this.exchangeKey().finally(() => {
        inflightExchange = null;
      });
    }
    const fresh = await inflightExchange;
    memoryToken = { ...fresh, keyId };
    await this.storeToken(fresh);
    return fresh;
  }

  private async exchangeKey(): Promise<CachedToken> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + TOKEN_PATH, {
        method: "POST",
        headers: { Authorization: `ApiKey ${this.env.GARMIN_API_KEY.trim()}`, Accept: "*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GarminError(`Could not reach Garmin to sign in (${describe(error)}). Try again in a moment.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new GarminError(
        "Garmin rejected the API key. It may have expired or been deleted. Create a new key in Garmin Connect (Settings > Personal API), then run `npx wrangler secret put GARMIN_API_KEY` and paste it.",
        response.status,
      );
    }
    if (!response.ok) throw await this.statusError(response, TOKEN_PATH);
    const value = (await response.text()).trim().replace(/^"|"$/g, "");
    if (!value) throw new GarminError("Garmin's sign-in endpoint returned an empty token.");
    return { value, expiresAt: jwtExpiry(value) ?? Date.now() + FALLBACK_LIFETIME_MS };
  }

  private async forgetToken(): Promise<void> {
    memoryToken = null;
    try {
      await this.env.OAUTH_KV.delete(TOKEN_KV_KEY);
    } catch {
      // best effort
    }
  }

  // The cached token is encrypted with a key derived from the API key, so the
  // KV entry is useless on its own and a rotated API key invalidates it.
  private async loadStoredToken(): Promise<CachedToken | null> {
    try {
      const raw = await this.env.OAUTH_KV.get(TOKEN_KV_KEY);
      if (!raw) return null;
      const [ivB64, dataB64] = raw.split(".");
      if (!ivB64 || !dataB64) return null;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(ivB64) },
        await this.cacheKey(),
        fromBase64(dataB64),
      );
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as CachedToken;
      if (typeof parsed.value !== "string" || typeof parsed.expiresAt !== "number") return null;
      return parsed;
    } catch {
      return null; // wrong key, corrupted, or KV unavailable: just exchange again
    }
  }

  private async storeToken(token: CachedToken): Promise<void> {
    const ttlSeconds = Math.floor((token.expiresAt - Date.now() - REFRESH_MARGIN_MS) / 1000);
    if (ttlSeconds < 60) return;
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await this.cacheKey(),
        new TextEncoder().encode(JSON.stringify(token)),
      );
      await this.env.OAUTH_KV.put(TOKEN_KV_KEY, `${toBase64(iv)}.${toBase64(new Uint8Array(data))}`, {
        expirationTtl: ttlSeconds,
      });
    } catch {
      // best effort: the in-memory copy still works
    }
  }

  private async cacheKey(): Promise<CryptoKey> {
    const material = await sha256(`garmin-token-cache\u0000${this.env.GARMIN_API_KEY.trim()}`);
    return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  private async keyId(): Promise<string> {
    return toBase64(new Uint8Array(await sha256(`garmin-key-id\u0000${this.env.GARMIN_API_KEY.trim()}`)));
  }
}

function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64(parts[1]))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text: string): Uint8Array {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timed out" : error.message;
  return String(error);
}

/** Exposed for tests. */
export function _resetTokenCacheForTests(): void {
  memoryToken = null;
  inflightExchange = null;
}
