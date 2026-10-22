// The sign-in page Claude opens once when you connect the connector.
// It asks for the owner passphrase, then lets the OAuth library hand Claude a
// token. Nothing about Garmin is exposed here.

import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";

export const SCOPE = "garmin:read";
const OWNER_ID = "owner";
const MIN_PASSPHRASE_LENGTH = 16;
const FAIL_WINDOW_SECONDS = 15 * 60;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_TOTAL = 20;

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.OWNER_PASSPHRASE || env.OWNER_PASSPHRASE.length < MIN_PASSPHRASE_LENGTH) {
      return page(
        "Connector not set up yet",
        `<p>The owner passphrase is missing or shorter than ${MIN_PASSPHRASE_LENGTH} characters. Run <code>npx wrangler secret put OWNER_PASSPHRASE</code>, then try connecting again.</p>`,
        500,
      );
    }
    if (request.method === "GET") return await showForm(request, env);
    if (request.method === "POST") return await submitForm(request, env);
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return page("Sign-in couldn't continue", `<p>${escape(error.description)}</p><p>Go back to Claude and start connecting again.</p>`, 400);
    }
    if (error instanceof CimdFetchError) {
      return page("Sign-in couldn't continue", "<p>The app asking for access could not be verified. Go back to Claude and try again.</p>", 400);
    }
    throw error;
  }
}

async function showForm(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return formPage(
    {
      handle: consent.handle,
      clientName: details.clientName,
      clientDomain: details.clientDomain,
      redirectHost: details.redirectHost,
      loopback: details.redirectIsLoopback,
    },
    consent.headers,
  );
}

async function submitForm(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const shown = {
    handle,
    clientName: String(form.get("client_name") ?? "Claude"),
    clientDomain: String(form.get("client_domain") ?? "") || undefined,
    redirectHost: String(form.get("redirect_host") ?? ""),
    loopback: form.get("loopback") === "1",
  };

  if (form.get("decision") === "deny") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (await tooManyFailures(env, ip)) {
    return formPage({ ...shown, error: "Too many wrong attempts. Wait 15 minutes, then try again." }, new Headers(), 429);
  }

  const attempt = String(form.get("passphrase") ?? "");
  if (!(await matches(attempt, env.OWNER_PASSPHRASE))) {
    await recordFailure(env, ip);
    return formPage({ ...shown, error: "That passphrase isn't right." }, new Headers(), 401);
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: OWNER_ID,
    metadata: { client: shown.clientName.slice(0, 100) },
    scope: [SCOPE],
    props: { owner: true },
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

// ---- passphrase check and attempt limits -----------------------------------

async function matches(attempt: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(attempt)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function tooManyFailures(env: Env, ip: string): Promise<boolean> {
  const [mine, all] = await Promise.all([env.OAUTH_KV.get(`authfail:ip:${ip}`), env.OAUTH_KV.get("authfail:all")]);
  return Number(mine ?? 0) >= MAX_FAILS_PER_IP || Number(all ?? 0) >= MAX_FAILS_TOTAL;
}

async function recordFailure(env: Env, ip: string): Promise<void> {
  const bump = async (key: string) => {
    const current = Number((await env.OAUTH_KV.get(key)) ?? 0);
    await env.OAUTH_KV.put(key, String(current + 1), { expirationTtl: FAIL_WINDOW_SECONDS });
  };
  await Promise.all([bump(`authfail:ip:${ip}`), bump("authfail:all")]);
}

// ---- pages -------------------------------------------------------------------

interface FormState {
  handle: string;
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  loopback: boolean;
  error?: string;
}

function formPage(state: FormState, headers: Headers, status = 200): Response {
  const who = state.clientDomain
    ? `<strong>${escape(state.clientName)}</strong> (published by ${escape(state.clientDomain)})`
    : `<strong>${escape(state.clientName)}</strong>`;
  const body = `
<p>${who} wants read-only access to your Garmin data through this connector.</p>
<p class="muted">Access will be sent to <strong>${escape(state.redirectHost)}</strong>.</p>
${state.loopback ? '<p class="warn">This sends access to an app on your own computer. Continue only if you just started connecting from it.</p>' : ""}
${state.error ? `<p class="error" role="alert">${escape(state.error)}</p>` : ""}
<form method="post" autocomplete="off">
  <input type="hidden" name="handle" value="${escape(state.handle)}">
  <input type="hidden" name="client_name" value="${escape(state.clientName)}">
  <input type="hidden" name="client_domain" value="${escape(state.clientDomain ?? "")}">
  <input type="hidden" name="redirect_host" value="${escape(state.redirectHost)}">
  <input type="hidden" name="loopback" value="${state.loopback ? "1" : "0"}">
  <label for="passphrase">Owner passphrase</label>
  <input id="passphrase" name="passphrase" type="password" required autofocus autocapitalize="off" spellcheck="false">
  <div class="buttons">
    <button name="decision" value="approve" class="primary">Allow</button>
    <button name="decision" value="deny" formnovalidate>Deny</button>
  </div>
</form>`;
  return page("Connect to your Garmin data", body, status, headers);
}

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "DENY");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --text: #16181d; --muted: #5b6270; --line: #d9dde3; --accent: #0b6e4f; --on-accent: #ffffff; --error: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --card: #1a1d23; --text: #e8eaee; --muted: #a1a8b3; --line: #2e333b; --accent: #3fb68b; --on-accent: #0b1a14; --error: #f97066; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: 0.9rem; }
  .warn { color: var(--error); font-size: 0.9rem; }
  .error { color: var(--error); font-weight: 600; }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input[type=password] { width: 100%; padding: 12px; font-size: 1rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  .buttons { display: flex; gap: 8px; margin-top: 16px; }
  button { flex: 1; padding: 12px; font-size: 1rem; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
  code { font-size: 0.9em; }
</style>
</head>
<body><main><div class="card"><h1>${escape(title)}</h1>${body}</div></main></body>
</html>`;
  return new Response(html, { status, headers });
}

export function infoPage(origin: string): Response {
  return page(
    "Garmin connector is running",
    `<p>Add this address in Claude as a custom connector:</p><p><code>${escape(origin)}/mcp</code></p>`,
  );
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
