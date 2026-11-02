import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay } from './backoff.ts';
import { BlindSignalClient, type BlindSignalClientOptions } from './client.ts';
import { BlindSignalError } from './errors.ts';
import { FakeSocket } from './testing/fake-socket.ts';

const identity = { userId: 'alice', deviceId: 'laptop' };
const iceConfig = { iceServers: [{ urls: ['turn:turn.example'], username: 'u', credential: 'c' }] };

function setup(options: Partial<BlindSignalClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  let issued = 0;
  const accessTokenProvider = vi.fn(() => Promise.resolve(`t${++issued}`));
  const client = new BlindSignalClient({
    serverUrl: 'wss://signal.example/',
    accessTokenProvider,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    },
    ...options,
  });
  const socket = () => sockets.at(-1)!;
  const last = () => socket().sent.at(-1) as { type: string; requestId: string; payload: object };
  const reply = (type: string, payload: object) =>
    socket().receive({ version: 1, type, requestId: last().requestId, payload });
  return { client, sockets, socket, last, reply, accessTokenProvider };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

async function connected(expiresInMs = 300_000, options?: Partial<BlindSignalClientOptions>) {
  const harness = setup(options);
  const connecting = harness.client.connect();
  await flush();
  harness.reply('auth.result', { ...identity, expiresInMs });
  harness.socket().receive({ version: 1, type: 'rtc.ice_config', payload: iceConfig });
  await connecting;
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BlindSignalClient', () => {
  it('refuses an insecure server URL', () => {
    expect(() => setup({ serverUrl: 'ws://signal.example/' })).toThrow(TypeError);
  });

  it('authenticates with a fresh token and keeps the ICE configuration', async () => {
    const { client, socket, accessTokenProvider } = setup();
    const connecting = client.connect();
    await flush();
    expect(socket().url.href).toBe('wss://signal.example/');
    expect(socket().sent).toEqual([
      { version: 1, type: 'auth.authenticate', requestId: 'r1', payload: { token: 't1' } },
    ]);
    socket().receive({
      version: 1,
      type: 'auth.result',
      requestId: 'r1',
      payload: { ...identity, expiresInMs: 300_000 },
    });
    socket().receive({ version: 1, type: 'rtc.ice_config', payload: iceConfig });
    await expect(connecting).resolves.toEqual(identity);
    expect(client.iceConfig).toEqual(iceConfig);
    expect(accessTokenProvider).toHaveBeenCalledTimes(1);
  });

  it('rejects with the provider error before opening a socket', async () => {
    const failure = new Error('backend down');
    const { client, sockets } = setup({ accessTokenProvider: () => Promise.reject(failure) });
    await expect(client.connect()).rejects.toBe(failure);
    expect(sockets).toHaveLength(0);
  });

  it('rejects with the server error and closes the socket', async () => {
    const { client, socket, reply } = setup();
    const connecting = client.connect();
    await flush();
    reply('error', { code: 'invalid_token' });
    await expect(connecting).rejects.toEqual(new BlindSignalError('invalid_token'));
    expect(socket().closedWith).toBe(1000);
  });

  it('refreshes with a new token before expiry and reschedules from the new result', async () => {
    const { last, reply, accessTokenProvider } = await connected(300_000);
    await vi.advanceTimersByTimeAsync(239_999);
    expect(last().type).toBe('auth.authenticate');
    await vi.advanceTimersByTimeAsync(1);
    expect(last()).toMatchObject({ type: 'auth.refresh', payload: { token: 't2' } });
    reply('auth.result', { ...identity, expiresInMs: 100_000 });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(accessTokenProvider).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(last()).toMatchObject({ type: 'auth.refresh', payload: { token: 't3' } });
  });

  it('refreshes at once when the token expires within the margin', async () => {
    const { last } = await connected(30_000, { refreshMarginMs: 60_000 });
    await flush();
    expect(last().type).toBe('auth.refresh');
  });

  it('retries a failed refresh with backoff until the token expires', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const backoff = { baseMs: 1_000, maxMs: 4_000 };
    const { socket, reply } = await connected(70_000, { backoff });
    const refreshes = () =>
      socket().sent.filter((m) => (m as { type: string }).type === 'auth.refresh');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshes()).toHaveLength(1);
    // Delays: 500, 1000, 2000, then 2000 (capped), until the 60 s left run out.
    const delays = [500, 1_000, 2_000, 2_000];
    for (const [i, delay] of delays.entries()) {
      reply('error', { code: 'identity_mismatch' });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(refreshes()).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshes()).toHaveLength(i + 2);
    }
    await vi.advanceTimersByTimeAsync(53_499);
    reply('error', { code: 'identity_mismatch' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshes()).toHaveLength(delays.length + 1);
  });

  it('retries when the provider fails during a refresh', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { accessTokenProvider, last } = await connected(70_000);
    accessTokenProvider.mockRejectedValueOnce(new Error('backend down'));
    await vi.advanceTimersByTimeAsync(10_499);
    expect(last().type).toBe('auth.authenticate');
    await vi.advanceTimersByTimeAsync(1);
    expect(last()).toMatchObject({ type: 'auth.refresh', payload: { token: 't2' } });
  });

  it('stops refreshing once closed', async () => {
    const { client, socket, accessTokenProvider } = await connected(70_000);
    client.close();
    expect(socket().closedWith).toBe(1000);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(accessTokenProvider).toHaveBeenCalledTimes(1);
  });

  it('stops refreshing when the connection drops', async () => {
    const { socket, accessTokenProvider } = await connected(70_000);
    socket().drop(1006);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(accessTokenProvider).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the connection drops during a refresh', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { socket, accessTokenProvider } = await connected(70_000);
    await vi.advanceTimersByTimeAsync(10_000);
    socket().drop(4001);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(accessTokenProvider).toHaveBeenCalledTimes(2);
  });
});

describe('BlindSignalClient after a reconnect', () => {
  /** Connects again with a long-lived token; any refresh on the new socket is a leftover. */
  async function reconnect(harness: Awaited<ReturnType<typeof connected>>) {
    const connecting = harness.client.connect();
    await flush();
    harness.reply('auth.result', { ...identity, expiresInMs: 3_600_000 });
    await connecting;
    await vi.advanceTimersByTimeAsync(120_000);
    return harness.socket().sent.filter((m) => (m as { type: string }).type === 'auth.refresh');
  }

  it('drops the refresh scheduled by a closed connection', async () => {
    const harness = await connected(70_000);
    harness.client.close();
    expect(await reconnect(harness)).toEqual([]);
  });

  it('drops the refresh scheduled by a dropped connection', async () => {
    const harness = await connected(70_000);
    harness.socket().drop(1006);
    expect(await reconnect(harness)).toEqual([]);
  });

  it('drops a refresh result that arrives after close', async () => {
    const harness = await connected(70_000);
    await vi.advanceTimersByTimeAsync(10_000);
    harness.client.close();
    harness.reply('auth.result', { ...identity, expiresInMs: 70_000 });
    expect(await reconnect(harness)).toEqual([]);
  });

  it('drops the retry of a refresh cut by a dropped connection', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const harness = await connected(70_000);
    await vi.advanceTimersByTimeAsync(10_000);
    harness.socket().drop(4001);
    expect(await reconnect(harness)).toEqual([]);
  });
});

describe('backoffDelay', () => {
  it('draws a full-jitter delay below the doubling, capped bound', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const options = { baseMs: 1_000, maxMs: 30_000 };
    expect([0, 1, 4, 5, 10].map((attempt) => backoffDelay(attempt, options))).toEqual([
      250, 500, 4_000, 7_500, 7_500,
    ]);
  });
});
