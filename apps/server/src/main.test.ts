import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const REGISTRY = fileURLToPath(new URL('../../../examples/registry.dev.json', import.meta.url));

// Loaded before main.ts: throws, or rejects with CRASH=reject, on SIGUSR2 or after CRASH_AFTER_MS.
// The message comes from the environment, so the module's URL in the stack never quotes it.
const CRASH = `data:text/javascript,${encodeURIComponent(`
  const crash = () => {
    if (process.env.CRASH === 'reject') void Promise.reject(new TypeError(process.env.CRASH_MESSAGE));
    else throw new TypeError(process.env.CRASH_MESSAGE);
  };
  process.once('SIGUSR2', crash);
  if (process.env.CRASH_AFTER_MS) setTimeout(crash, Number(process.env.CRASH_AFTER_MS));
`)}`;

interface Entry {
  readonly event: string;
  readonly port?: number;
  readonly [field: string]: unknown;
}

/** Starts the server process, collecting its log entries as it writes them. */
function start(env: Record<string, string>, execArgv: string[] = []) {
  const child = spawn(process.execPath, [...execArgv, MAIN], {
    env: {
      PATH: process.env.PATH,
      BLINDSIGNAL_ENV: 'development',
      BLINDSIGNAL_REGISTRY_PATH: REGISTRY,
      BLINDSIGNAL_PORT: '0',
      BLINDSIGNAL_ADMIN_PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const entries: Entry[] = [];
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const entry = JSON.parse(line) as Entry;
      entries.push(entry);
      child.emit('entry', entry);
    }
  });
  return { child, entries, exited };
}

/** Starts the server process; resolves once it listens, with its ports and its log events. */
async function launch(env: Record<string, string>, execArgv: string[] = []) {
  const { child, entries, exited } = start(env, execArgv);
  const port = await new Promise<number>((resolve, reject) => {
    child.on('entry', (entry: Entry) => {
      if (entry.event === 'server.listening') resolve(entry.port ?? 0);
    });
    void exited.then(() =>
      reject(new Error(`exited before listening: ${entries.map((e) => e.event).join(', ')}`)),
    );
  });
  const events = {
    includes: (event: string) => entries.some((entry) => entry.event === event),
  };
  return { child, port, events, entries, exited };
}

// Each test starts a server process, which takes seconds on a loaded machine.
describe('shutdown (ADR 0031)', { timeout: 30_000 }, () => {
  it('fails readiness during the delay, then closes connections and exits with 0', async () => {
    const { child, port, events, exited } = await launch({
      BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS: '1',
      BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS: '5',
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => ws.once('open', resolve));
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    const signalled = Date.now();
    child.kill('SIGTERM');
    await expect
      .poll(async () => (await fetch(`http://127.0.0.1:${port}/readyz`)).status)
      .toBe(503);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(await closed).toBe(1001);
    expect(Date.now() - signalled).toBeGreaterThanOrEqual(1000);
    expect(await exited).toBe(0);
    expect(events.includes('server.shutdown_timeout')).toBe(false);
  });

  it('exits with 1 when a connection never finishes closing', async () => {
    const { child, port, events, exited } = await launch({
      BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS: '1',
    });
    // Completes the upgrade, then never answers the close frame: ws would wait 30 seconds.
    const socket = connect(port, '127.0.0.1');
    socket.write(
      'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    await new Promise((resolve) => socket.once('data', resolve));
    const signalled = Date.now();
    child.kill('SIGTERM');
    expect(await exited).toBe(1);
    expect(Date.now() - signalled).toBeLessThan(5000);
    expect(events.includes('server.shutdown_timeout')).toBe(true);
    socket.destroy();
  });
});

describe('crashes (ADR 0037)', { timeout: 30_000 }, () => {
  it.each(['throw', 'reject'])(
    'logs an uncaught %s as JSON, without its message, and exits with 1',
    async (kind) => {
      const { child, entries, exited } = await launch(
        { CRASH: kind, CRASH_MESSAGE: 'secret-value' },
        ['--import', CRASH],
      );
      child.kill('SIGUSR2');
      expect(await exited).toBe(1);
      const crashed = entries.find((entry) => entry.event === 'server.crashed');
      expect(crashed).toMatchObject({
        level: 'error',
        origin: kind === 'throw' ? 'uncaughtException' : 'unhandledRejection',
        reason: 'TypeError',
      });
      expect(crashed?.stack).toMatch(/^at /);
      expect(JSON.stringify(entries)).not.toContain('secret-value');
    },
  );

  it('writes only the events at BLINDSIGNAL_LOG_LEVEL or above', async () => {
    const { entries, exited } = start({ BLINDSIGNAL_LOG_LEVEL: 'error', CRASH_AFTER_MS: '2000' }, [
      '--import',
      CRASH,
    ]);
    expect(await exited).toBe(1);
    expect(entries.map((entry) => entry.event)).toEqual(['server.crashed']);
  });
});
