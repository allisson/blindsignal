import { z } from 'zod';
import type { ErrorCode } from './errors.ts';
import { requestId } from './ids.ts';
import {
  messages,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Direction,
  type Message,
  type MessageType,
  type ServerMessage,
} from './messages.ts';

/** Absolute ceiling for the configured maximum message size, in UTF-8 bytes; also the default. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

export interface ParseOptions {
  maxBytes?: number;
}

export type ParseResult<M> =
  | { ok: true; message: M }
  | {
      ok: false;
      code: Extract<
        ErrorCode,
        'message_too_large' | 'malformed_frame' | 'unsupported_version' | 'invalid_message'
      >;
      /** The rejected message's `requestId`, when it had a valid one, to echo in the `error`. */
      requestId?: string;
    };

const versioned = z.object({ version: z.int().positive() });
const envelope = z.object({
  type: z.string(),
  requestId: requestId.optional(),
  payload: z.looseObject({}),
});
const withRequestId = z.object({ requestId });
const encoder = new TextEncoder();

/** Parses a frame received by the server. */
export function parseClientMessage(
  text: string,
  options?: ParseOptions,
): ParseResult<ClientMessage> {
  return parse(text, ['client', 'relay'], true, options) as ParseResult<ClientMessage>;
}

/** Parses a frame received by the SDK. */
export function parseServerMessage(
  text: string,
  options?: ParseOptions,
): ParseResult<ServerMessage> {
  return parse(text, ['server', 'relay'], false, options) as ParseResult<ServerMessage>;
}

function parse(
  text: string,
  allowed: Direction[],
  requireRequestId: boolean,
  { maxBytes = MAX_MESSAGE_BYTES }: ParseOptions = {},
): ParseResult<Message> {
  // A string's UTF-8 length is never below its UTF-16 length: skip encoding obvious oversizes.
  if (text.length > maxBytes || encoder.encode(text).byteLength > maxBytes) {
    return { ok: false, code: 'message_too_large' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, code: 'malformed_frame' };
  }
  const id = withRequestId.safeParse(data).data?.requestId;
  const reject = (code: 'unsupported_version' | 'invalid_message') =>
    ({ ok: false, code, ...(id === undefined ? {} : { requestId: id }) }) as const;

  // The version is checked first, so another major version's envelope is never misread as v1.
  const version = versioned.safeParse(data);
  if (!version.success) return reject('invalid_message');
  if (version.data.version !== PROTOCOL_VERSION) return reject('unsupported_version');

  const env = envelope.safeParse(data);
  if (!env.success || (requireRequestId && env.data.requestId === undefined)) {
    return reject('invalid_message');
  }
  if (!Object.hasOwn(messages, env.data.type)) return reject('invalid_message');
  const type = env.data.type as MessageType;
  const spec = messages[type];
  if (!allowed.includes(spec.direction)) return reject('invalid_message');

  const payload = spec.payload.safeParse(env.data.payload);
  if (!payload.success) return reject('invalid_message');
  return {
    ok: true,
    message: {
      version: PROTOCOL_VERSION,
      type,
      ...(env.data.requestId === undefined ? {} : { requestId: env.data.requestId }),
      payload: payload.data,
    } as Message,
  };
}
