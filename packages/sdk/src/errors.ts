import type { ErrorCode } from '@blindsignal/protocol';

/**
 * A failed request. `code` is the server's error code, `connection_closed` when the connection
 * closed before the reply, or `protocol_error` when the server replied with an unexpected type.
 */
export class BlindSignalError extends Error {
  readonly code: ErrorCode | 'connection_closed' | 'protocol_error';
  readonly retryAfterMs: number | undefined;

  constructor(code: BlindSignalError['code'], retryAfterMs?: number) {
    super(code);
    this.name = 'BlindSignalError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
