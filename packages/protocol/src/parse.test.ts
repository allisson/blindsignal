import { describe, expect, it } from 'vitest';
import { messages, type MessageType } from './messages.ts';
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
    ['a client-sent rtc.ice_config', client('rtc.ice_config', { iceServers: [] })],
    [
      'a client-sent session.terminated',
      client('session.terminated', { sessionId, reason: 'closed_by_peer' }),
    ],
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
    ['an empty error code', frame({ version: 1, type: 'error', payload: { code: '' } })],
    [
      'an empty termination reason',
      frame({ version: 1, type: 'session.terminated', payload: { sessionId, reason: '' } }),
    ],
    [
      'an ICE server without urls',
      frame({ version: 1, type: 'rtc.ice_config', payload: { iceServers: [{ urls: [] }] } }),
    ],
  ])('rejects %s', (_, text) => {
    expect(parseServerMessage(text)).toMatchObject({ ok: false, code: 'invalid_message' });
  });
});

// What docs/protocol.md §2 lets a later release of version 1 send to a client of this one.
describe('a client of this release reading a later release of the same version', () => {
  const device = { namespace: 'chat:room-1', userId: 'u', deviceId: 'd' };
  const pairing = { pairingId: sessionId };
  const sent: Record<string, object> = {
    'auth.challenge': { nonce: 'n' },
    'auth.result': { userId: 'u', deviceId: 'd', expiresInMs: 1000 },
    'presence.changed': { ...device, present: true },
    'discovery.result': { namespace: device.namespace, devices: [{ deviceId: 'd', userId: 'u' }] },
    'session.created': { sessionId },
    'session.request': { sessionId, ...device },
    'session.accepted': { sessionId },
    'session.rejected': { sessionId },
    'session.terminated': { sessionId, reason: 'timeout' },
    'pairing.created': pairing,
    'pairing.request': { ...pairing, ...device, jkt: 'k' },
    'pairing.approved': { ...pairing, approval: 'a.b.c' },
    'pairing.rejected': pairing,
    'pairing.ended': { ...pairing, reason: 'timeout' },
    'rtc.offer': { sessionId, sdp: 'v=0' },
    'rtc.answer': { sessionId, sdp: 'v=0' },
    'rtc.ice_candidate': { sessionId, candidate: 'candidate:1' },
    'rtc.ice_config': { iceServers: [{ urls: ['turn:t'], username: 'u', credential: 'c' }] },
    'connection.pong': {},
    ack: {},
    error: { code: 'rate_limited', retryAfterMs: 500 },
  };
  /** The same value with a field this release does not know in every object. */
  const extended = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(extended)
      : typeof value === 'object' && value !== null
        ? {
            ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, extended(v)])),
            later: 1,
          }
        : value;

  it('has a sample of every type the server sends', () => {
    const received = (Object.keys(messages) as MessageType[]).filter(
      (type) => messages[type].direction !== 'client',
    );
    expect(Object.keys(sent).sort()).toEqual(received.sort());
  });

  it.each(Object.entries(sent))(
    'reads %s with optional fields it does not know',
    (type, payload) => {
      const message = { version: 1, type, requestId: 'r-1', payload };
      expect(parseServerMessage(frame(extended(message)))).toEqual({ ok: true, message });
    },
  );

  it('rejects a server message type it does not know, for the SDK to ignore', () => {
    const text = client('session.moved', { sessionId });
    expect(parseServerMessage(text)).toEqual({
      ok: false,
      code: 'invalid_message',
      requestId: 'r-1',
    });
  });

  it.each([
    ['error', { code: 'server_draining', retryAfterMs: 500 }],
    ['session.terminated', { sessionId, reason: 'peer_moved' }],
    ['pairing.ended', { pairingId: sessionId, reason: 'cancelled' }],
  ])('keeps a %s value that a later release adds (ADR 0045)', (type, payload) => {
    expect(parseServerMessage(frame({ version: 1, type, payload }))).toEqual({
      ok: true,
      message: { version: 1, type, payload },
    });
  });
});
