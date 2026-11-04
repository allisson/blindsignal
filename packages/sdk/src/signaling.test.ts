import { describe, expect, it } from 'vitest';
import { BlindSignalError } from './errors.ts';
import { Signaling } from './signaling.ts';
import { FakeSocket } from './testing/fake-socket.ts';

const url = new URL('wss://signal.example/');

function opening() {
  let socket!: FakeSocket;
  const signaling = Signaling.open(
    url,
    (u) => (socket = new FakeSocket(u)) as unknown as WebSocket,
  );
  return { signaling, socket };
}

async function connect() {
  const { signaling, socket } = opening();
  socket.open();
  const opened = await signaling;
  const messages: unknown[] = [];
  const closes: unknown[] = [];
  opened.on('message', (m) => messages.push(m));
  opened.on('close', (c) => closes.push(c));
  return { signaling: opened, socket, messages, closes };
}

const reply = (type: string, requestId: string, payload: object = {}) => ({
  version: 1,
  type,
  requestId,
  payload,
});

describe('Signaling', () => {
  it('opens the URL as given', async () => {
    const { socket } = await connect();
    expect(socket.url).toBe(url);
  });

  it('rejects with connection_closed when the socket closes before opening', async () => {
    const { signaling, socket } = opening();
    socket.drop(1006);
    await expect(signaling).rejects.toEqual(new BlindSignalError('connection_closed'));
  });

  it('sends versioned requests with fresh request IDs and resolves their replies', async () => {
    const { signaling, socket } = await connect();
    const joined = signaling.request('namespace.join', { namespace: 'notes:a' });
    const pong = signaling.request('connection.ping', {});
    expect(socket.sent).toEqual([
      { version: 1, type: 'namespace.join', requestId: 'r1', payload: { namespace: 'notes:a' } },
      { version: 1, type: 'connection.ping', requestId: 'r2', payload: {} },
    ]);
    socket.receive(reply('connection.pong', 'r2'));
    socket.receive(reply('ack', 'r1'));
    expect(await joined).toEqual({ version: 1, type: 'ack', requestId: 'r1', payload: {} });
    expect(await pong).toMatchObject({ type: 'connection.pong' });
  });

  it('rejects a request with the error the server replied', async () => {
    const { signaling, socket } = await connect();
    const discovery = signaling.request('discovery.request', { namespace: 'notes:a' });
    const join = signaling.request('namespace.join', { namespace: 'notes:a' });
    socket.receive(reply('error', 'r1', { code: 'not_joined' }));
    socket.receive(reply('error', 'r2', { code: 'rate_limited', retryAfterMs: 500 }));
    await expect(discovery).rejects.toMatchObject({ code: 'not_joined', retryAfterMs: undefined });
    await expect(join).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 500 });
  });

  it('rejects a request with an error code that a later server adds (ADR 0045)', async () => {
    const { signaling, socket, closes } = await connect();
    const join = signaling.request('namespace.join', { namespace: 'notes:a' });
    socket.receive(reply('error', 'r1', { code: 'account_closed' }));
    await expect(join).rejects.toEqual(new BlindSignalError('account_closed'));
    socket.drop(4002);
    expect(closes).toEqual([{ code: 4002, error: 'account_closed' }]);
  });

  it('ignores a message type it does not know, and still settles the request', async () => {
    const { signaling, socket, messages } = await connect();
    const join = signaling.request('namespace.join', { namespace: 'notes:a' });
    socket.receive(reply('namespace.moved', 'r1', { namespace: 'notes:b' }));
    socket.receive({ version: 1, type: 'namespace.moved', payload: { namespace: 'notes:b' } });
    expect(messages).toEqual([]);
    socket.receive(reply('ack', 'r1'));
    await expect(join).resolves.toMatchObject({ type: 'ack' });
  });

  it('rejects a reply of the wrong type with protocol_error', async () => {
    const { signaling, socket } = await connect();
    const join = signaling.request('namespace.join', { namespace: 'notes:a' });
    socket.receive(reply('connection.pong', 'r1'));
    await expect(join).rejects.toEqual(new BlindSignalError('protocol_error'));
  });

  it('emits events, relayed messages, and replies to no pending request', async () => {
    const { signaling, socket, messages } = await connect();
    const sessionId = crypto.randomUUID();
    expect(signaling.relay('rtc.offer', { sessionId, sdp: 'v=0' })).toBe('r1');
    expect(socket.sent).toEqual([
      { version: 1, type: 'rtc.offer', requestId: 'r1', payload: { sessionId, sdp: 'v=0' } },
    ]);
    const event = { version: 1, type: 'session.accepted', payload: { sessionId } };
    const relayed = { version: 1, type: 'rtc.answer', payload: { sessionId, sdp: 'v=0' } };
    const failure = reply('error', 'r1', { code: 'session_unavailable' });
    socket.receive(event);
    socket.receive(relayed);
    socket.receive(failure);
    expect(messages).toEqual([event, relayed, failure]);
  });

  it('drops binary, malformed, and invalid frames', async () => {
    const { signaling, socket, messages } = await connect();
    const join = signaling.request('namespace.join', { namespace: 'notes:a' });
    socket.receive(new ArrayBuffer(8));
    socket.receive('{not json');
    socket.receive(reply('session.request', 'r1'));
    socket.receive({
      version: 1,
      type: 'auth.authenticate',
      requestId: 'r1',
      payload: { token: 't' },
    });
    socket.receive({ version: 2, type: 'ack', requestId: 'r1', payload: {} });
    expect(messages).toEqual([]);
    socket.receive(reply('ack', 'r1'));
    await expect(join).resolves.toMatchObject({ type: 'ack' });
  });

  it('rejects pending and later requests once closed', async () => {
    const { signaling, socket, closes } = await connect();
    const join = signaling.request('namespace.join', { namespace: 'notes:a' });
    socket.drop(1006);
    await expect(join).rejects.toEqual(new BlindSignalError('connection_closed'));
    await expect(signaling.request('connection.ping', {})).rejects.toEqual(
      new BlindSignalError('connection_closed'),
    );
    const sessionId = crypto.randomUUID();
    expect(() => signaling.relay('rtc.offer', { sessionId, sdp: 'v=0' })).toThrow(
      new BlindSignalError('connection_closed'),
    );
    expect(closes).toEqual([{ code: 1006 }]);
    expect(socket.sent).toHaveLength(1);
  });

  it('reports the error code sent before a protocol class close', async () => {
    const { socket, closes } = await connect();
    socket.receive({ version: 1, type: 'error', payload: { code: 'superseded' } });
    socket.drop(4003);
    expect(closes).toEqual([{ code: 4003, error: 'superseded' }]);
  });

  it('leaves the error code out of other closes', async () => {
    const { socket, closes } = await connect();
    socket.receive({ version: 1, type: 'error', payload: { code: 'not_authorized' } });
    socket.drop(1001);
    expect(closes).toEqual([{ code: 1001 }]);
  });

  it('closes the socket normally', async () => {
    const { signaling, socket } = await connect();
    signaling.close();
    expect(socket.closedWith).toBe(1000);
  });

  it('keeps the challenge nonce out of the messages, and rejects it on an early close', async () => {
    const { signaling, socket, messages } = await connect();
    socket.receive({ version: 1, type: 'auth.challenge', payload: { nonce: 'n1' } });
    await expect(signaling.challenge).resolves.toBe('n1');
    expect(messages).toEqual([]);
    const other = await connect();
    other.socket.drop(1006);
    await expect(other.signaling.challenge).rejects.toMatchObject({ code: 'connection_closed' });
  });
});
