/** `'*'` allows every origin; otherwise the exact serialized origins allowed. */
export type AllowedOrigins = '*' | ReadonlySet<string>;

/**
 * The `Origin` check at the WebSocket upgrade (spec §16), defense in depth, never authentication.
 * No `Origin` header means a non-browser client, which the token alone guards.
 */
export function isOriginAllowed(origin: string | undefined, allowed: AllowedOrigins): boolean {
  return origin === undefined || allowed === '*' || allowed.has(origin);
}
