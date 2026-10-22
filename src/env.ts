import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** Garmin Connect Personal API key (secret). */
  GARMIN_API_KEY: string;
  /** Passphrase the owner types once when connecting Claude (secret). */
  OWNER_PASSPHRASE: string;
  /** Sign-in records and the encrypted Garmin token cache. */
  OAUTH_KV: KVNamespace;
  /** IANA time zone used for "today" and default date ranges. */
  TIMEZONE?: string;
  /** Optional: the connector's public address, e.g. https://garmin-connector.you.workers.dev. Defaults to the first request's address. */
  PUBLIC_URL?: string;
  /** Testing only: point the client at a mock Garmin API. Leave unset in production. */
  GARMIN_BASE_URL?: string;
  /** Injected by the OAuth library into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}
