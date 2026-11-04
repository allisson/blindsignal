export type ErrorClass = 'retryable' | 'terminal' | 'superseded';

// Code → class, from docs/protocol.md §9. Whether a code closes the connection is the server's call.
export const errorClasses = {
  invalid_message: 'retryable',
  malformed_frame: 'terminal',
  message_too_large: 'terminal',
  unsupported_version: 'terminal',
  not_authenticated: 'terminal',
  not_authorized: 'retryable',
  not_joined: 'retryable',
  peer_unavailable: 'retryable',
  session_unavailable: 'retryable',
  pairing_unavailable: 'retryable',
  rate_limited: 'retryable',
  quota_exceeded: 'retryable',
  invalid_token: 'retryable',
  token_expired: 'retryable',
  identity_mismatch: 'retryable',
  application_unavailable: 'terminal',
  device_revoked: 'terminal',
  superseded: 'superseded',
  server_error: 'retryable',
} as const satisfies Record<string, ErrorClass>;

export type ErrorCode = keyof typeof errorClasses;

export const closeCodes = {
  retryable: 4001,
  terminal: 4002,
  superseded: 4003,
} as const satisfies Record<ErrorClass, number>;

export function closeCodeFor(code: ErrorCode): number {
  return closeCodes[errorClasses[code]];
}
