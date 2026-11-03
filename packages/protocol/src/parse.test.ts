import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, parseClientMessage, parseServerMessage } from './parse.ts';

const sessionId = '0b6c1a52-6f0c-4c1e-9f3a-2d7e8c4b5a61';
const frame = (message: unknown) => JSON.stringify(message);
const client = (type: string, payload: unknown, extra: object = {}) =>
  frame({ version: 1, type, requestId: 'r-1', payload, ...extra });

describe('parseClientMessage', () => {
  it('accepts a valid request', () => {
    expect(parseClientMessage(client('namespace.join', { namespace: 'chat:room-1' }))).toEqual({
      ok: true,
      message: {
        version: 1,
        type: 'namespace.join',
        requestId: 'r-1',
        payload: { namespace: 'chat:room-1' },
      },
    });
  });

  it('accepts a relayed message', () => {
    const result = parseClientMessage(client('rtc.offer', { sessionId, sdp: 'v=0' }));
    expect(result.ok).toBe(true);
  });

  it('strips unknown keys from the envelope and the payload', () => {
    const result = parseClientMessage(
      client('auth.authenticate', { token: 't', extra: 1 }, { sender: 'x' }),
    );
    expect(result).toEqual({
      ok: true,
      message: {
        version: 1,
        type: 'auth.authenticate',
        requestId: 'r-1',
        payload: { token: 't' },
      },
    });
  });

  it('keeps an optional proof on auth messages, never an empty one (ADR 0041)', () => {
    const result = parseClientMessage(client('auth.refresh', { token: 't', proof: 'p' }));
    expect(result.ok && result.message.payload).toEqual({ token: 't', proof: 'p' });
    expect(parseClientMessage(client('auth.authenticate', { token: 't', proof: '' }))).toEqual({
      ok: false,
      code: 'invalid_message',
      requestId: 'r-1',
    });
  });

  it('rejects a message above the size limit', () => {
    const big = client('auth.authenticate', { token: 'x'.repeat(MAX_MESSAGE_BYTES) });
    expect(parseClientMessage(big)).toEqual({ ok: false, code: 'message_too_large' });
  });

  it('counts the size in UTF-8 bytes', () => {
    const text = client('auth.authenticate', { token: 'é'.repeat(40) });
    const bytes = text.length + 40;
    expect(parseClientMessage(text, { maxBytes: bytes - 1 })).toEqual({
      ok: false,
      code: 'message_too_large',
    });
    expect(parseClientMessage(text, { maxBytes: bytes }).ok).toBe(true);
  });

  it('rejects invalid JSON as a malformed frame', () => {
    expect(parseClientMessage('{"version":')).toEqual({ ok: false, code: 'malformed_frame' });
  });

  it('rejects another protocol version before reading the envelope', () => {
    expect(parseClientMessage(frame({ version: 2, requestId: 'r-9' }))).toEqual({
      ok: false,
      code: 'unsupported_version',
      requestId: 'r-9',
    });
  });

  it.each([
    ['a non-object', frame([1])],
    ['a missing version', frame({ type: 'connection.ping', requestId: 'r-1', payload: {} })],
    ['a non-integer version', client('connection.ping', {}, { version: 1.5 })],
    ['a missing payload', frame({ version: 1, type: 'connection.ping', requestId: 'r-1' })],
    ['an array payload', client('connection.ping', [])],
    ['a missing requestId', frame({ version: 1, type: 'connection.ping', payload: {} })],
    ['an empty requestId', client('connection.ping', {}, { requestId: '' })],
    [
      'a requestId above 64 characters',
      client('connection.ping', {}, { requestId: 'r'.repeat(65) }),
    ],
    ['an unknown type', client('connection.unknown', {})],
    ['an inherited property as type', client('toString', {})],
    ['a server-only type', client('session.request', { sessionId })],
    ['an invalid payload', client('session.accept', { sessionId: 'not-a-uuid' })],
  ])('rejects %s as an invalid message', (_, text) => {
    const result = parseClientMessage(text);
    expect(result).toMatchObject({ ok: false, code: 'invalid_message' });
  });

  it('echoes a valid requestId on an invalid message', () => {
    expect(parseClientMessage(client('rtc.ice_config', { iceServers: [] }))).toEqual({
      ok: false,
      code: 'invalid_message',
      requestId: 'r-1',
    });
  });

  it('omits an invalid requestId from the rejection', () => {
    expect(parseClientMessage(client('connection.ping', {}, { requestId: 42 }))).toEqual({
      ok: false,
      code: 'invalid_message',
    });
  });
});

describe('parseServerMessage', () => {
  it('accepts an event without requestId', () => {
    const text = frame({
      version: 1,
      type: 'session.terminated',
      payload: { sessionId, reason: 'timeout' },
    });
    expect(parseServerMessage(text)).toEqual({
      ok: true,
      message: {
        version: 1,
        type: 'session.terminated',
        payload: { sessionId, reason: 'timeout' },
      },
    });
  });

  it('accepts a reply with requestId', () => {
    const text = client('error', { code: 'rate_limited', retryAfterMs: 500 });
    expect(parseServerMessage(text)).toMatchObject({
      ok: true,
      message: { requestId: 'r-1', payload: { code: 'rate_limited', retryAfterMs: 500 } },
    });
  });

  it('accepts a relayed message', () => {
    const text = frame({
      version: 1,
      type: 'rtc.ice_candidate',
      payload: { sessionId, candidate: 'candidate:1' },
    });
    expect(parseServerMessage(text).ok).toBe(true);
  });

  it("keeps the requester's key thumbprint on a pairing request (ADR 0042)", () => {
    const device = { pairingId: sessionId, namespace: 'chat:room-1', userId: 'u', deviceId: 'd' };
    const request = (payload: object) => frame({ version: 1, type: 'pairing.request', payload });
    const result = parseServerMessage(request({ ...device, jkt: 'k' }));
    expect(result.ok && result.message.payload).toEqual({ ...device, jkt: 'k' });
    for (const jkt of [undefined, '']) {
      expect(parseServerMessage(request({ ...device, jkt }))).toMatchObject({ ok: false });
    }
  });

  it.each([
    ['a client-only type', frame({ version: 1, type: 'auth.refresh', payload: { token: 't' } })],
    ['an unknown error code', frame({ version: 1, type: 'error', payload: { code: 'oops' } })],
    [
      'an unknown termination reason',
      frame({ version: 1, type: 'session.terminated', payload: { sessionId, reason: 'gone' } }),
    ],
    [
      'an ICE server without urls',
      frame({ version: 1, type: 'rtc.ice_config', payload: { iceServers: [{ urls: [] }] } }),
    ],
  ])('rejects %s', (_, text) => {
    expect(parseServerMessage(text)).toMatchObject({ ok: false, code: 'invalid_message' });
  });
});
