import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const REGISTRY = fileURLToPath(new URL('../../../examples/registry.dev.json', import.meta.url));

/** Starts the server process; resolves once it listens, with its ports and its log events. */
async function launch(env: Record<string, string>) {
  const child = spawn(process.execPath, [MAIN], {
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
  const events: string[] = [];
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const entry = JSON.parse(line) as { event: string; port?: number };
        events.push(entry.event);
        if (entry.event === 'server.listening') resolve(entry.port ?? 0);
      }
    });
    void exited.then(() => reject(new Error(`exited before listening: ${events.join(', ')}`)));
  });
  return { child, port, events, exited };
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
    expect(events).not.toContain('server.shutdown_timeout');
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
    expect(events).toContain('server.shutdown_timeout');
    socket.destroy();
  });
});
