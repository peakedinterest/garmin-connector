// Garmin connector for Claude.
//
//   /mcp            the connector Claude talks to (requires sign-in)
//   /authorize      the one-time sign-in page (owner passphrase)
//   /oauth/*        token and client-registration endpoints (handled by the OAuth library)
//   /               a status page showing the address to add in Claude

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { handleAuthorize, infoPage, SCOPE } from "./authorize";
import type { Env } from "./env";
import { buildServer } from "./tools";

const DAY = 24 * 60 * 60;

const mcpApi = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handler = createMcpHandler(() => buildServer(env), {
      onerror: (error) => console.error("mcp error", error.message),
    });
    return handler.fetch(request);
  },
};

const site = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/" && request.method === "GET") return infoPage(url.origin);
    return new Response("Not found", { status: 404 });
  },
};

// The OAuth resource must be this Worker's own public address. It's only known
// once deployed, so it comes from PUBLIC_URL if set, otherwise from the first
// request. The connector answers at that one address only.
let active: { origin: string; provider: OAuthProvider<Env> } | null = null;

function providerFor(origin: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApi,
    defaultHandler: site,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${origin}/mcp` },
    accessTokenTTL: 60 * 60,
    // Stay signed in while the connector is used at least every 90 days.
    refreshTokenTTL: 90 * DAY,
    refreshTokenIdleTTL: 90 * DAY,
  });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = new URL(request.url).origin;
    if (!active) {
      const configured = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : origin;
      active = { origin: configured, provider: providerFor(configured) };
    }
    if (origin !== active.origin) {
      return Promise.resolve(
        new Response(`This connector answers at ${active.origin}`, { status: 421, headers: { "Content-Type": "text/plain" } }),
      );
    }
    return active.provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
