// Load test of the signaling server (ADR 0049): a fleet of devices of one application, sessions
// between them, and a restart they all reconnect from, measured against the server defaults.
// Usage: node tests/load/load.ts [--smoke] [--devices N] [--instances 2 --database-url U --redis-url U]
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { mintDevToken } from '@blindsignal/dev-issuer';
import { PROTOCOL_VERSION } from '@blindsignal/protocol';
import { WebSocket } from 'ws';

const { values: args } = parseArgs({
  options: {
    smoke: { type: 'boolean', default: false },
    devices: { type: 'string' },
    rate: { type: 'string' },
    hold: { type: 'string' },
    candidates: { type: 'string', default: '10' },
    'sdp-bytes': { type: 'string', default: '4096' },
    instances: { type: 'string', default: '1' },
    'database-url': { type: 'string' },
    'redis-url': { type: 'string' },
    port: { type: 'string', default: '18080' },
  },
});

const smoke = args.smoke;
const devices = Number(args.devices ?? (smoke ? 100 : 10_000));
const rate = Number(args.rate ?? (smoke ? 200 : 500));
const holdSeconds = Number(args.hold ?? (smoke ? 1 : 65));
const candidates = Number(args.candidates);
const sdpBytes = Number(args['sdp-bytes']);
const instances = Number(args.instances);
const basePort = Number(args.port);
if (instances > 1 && !(args['database-url'] && args['redis-url'])) {
  throw new Error('several instances need --database-url and --redis-url');
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const appId = 'notes';
// The restart reconnects over IPv6: the fleet's old connections hold their IPv4 ports in TIME_WAIT,
// and one host has 16k ephemeral ports per address on macOS, too few for both.
let host = '127.0.0.1';
const perUser = 4;

// --- Measurements ----------------------------------------------------------------------------

const rejections = new Map<string, number>();
const reject = (code: string) => rejections.set(code, (rejections.get(code) ?? 0) + 1);

function percentiles(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: sorted.length, p50: round(at(0.5)), p99: round(at(0.99)), max: round(sorted.at(-1)) };
}
const round = (ms: number | undefined) => (ms === undefined ? null : Math.round(ms * 10) / 10);

function report(phase: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ phase, ...fields }));
}

const clientLoop = monitorEventLoopDelay();
clientLoop.enable();
function clientLoopP99() {
  const p99 = clientLoop.percentile(99) / 1e6;
  clientLoop.reset();
  return round(p99);
}

// --- Server instances ------------------------------------------------------------------------

interface Instance {
  readonly port: number;
  readonly adminPort: number;
  process?: ChildProcess;
}

const servers: Instance[] = Array.from({ length: instances }, (_, i) => ({
  port: basePort + i,
  adminPort: basePort + 100 + i,
}));

const storageEnv: Record<string, string> = {
  ...(args['database-url'] && { BLINDSIGNAL_DATABASE_URL: args['database-url'] }),
  ...(args['redis-url'] && { BLINDSIGNAL_REDIS_URL: args['redis-url'] }),
};

async function start(server: Instance) {
  const child = spawn(process.execPath, ['apps/server/src/main.ts'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      ...storageEnv,
      BLINDSIGNAL_ENV: 'development',
      BLINDSIGNAL_PORT: String(server.port),
      BLINDSIGNAL_ADMIN_PORT: String(server.adminPort),
      BLINDSIGNAL_REGISTRY_PATH: 'examples/registry.dev.json',
      BLINDSIGNAL_LOG_LEVEL: 'error',
      // Every device sends its own client IP from loopback, so the per-IP limits stay at their
      // defaults and each device has its own buckets (ADR 0011).
      BLINDSIGNAL_TRUSTED_PROXIES: '127.0.0.1,::1',
    },
  });
  server.process = child;
  for (let tries = 0; ; tries++) {
    try {
      if ((await fetch(`http://127.0.0.1:${server.port}/readyz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    if (tries > 300 || child.exitCode !== null)
      throw new Error(`instance ${server.port} did not start`);
    await sleep(100);
  }
}

async function stop(server: Instance) {
  const child = server.process;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function sample(server: Instance) {
  const text = await (await fetch(`http://127.0.0.1:${server.adminPort}/metrics`)).text();
  const metric = (name: string) =>
    Number(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, 'm').exec(text)?.[1]);
  const cpu = execFileSync('ps', ['-o', 'time=', '-p', String(server.process!.pid)])
    .toString()
    .trim();
  return {
    port: server.port,
    connections: metric('blindsignal_connections'),
    rssMiB: Math.round(metric('process_resident_memory_bytes') / 2 ** 20),
    heapMiB: Math.round(metric('nodejs_heap_size_used_bytes') / 2 ** 20),
    loopP99Ms: round(
      Number(/^nodejs_eventloop_delay_seconds\{stat="p99"\} (\S+)$/m.exec(text)?.[1]) * 1000,
    ),
    cpuSeconds: cpuSeconds(cpu),
  };
}

// `ps -o time=`: [[dd-]hh:]mm:ss.cc
function cpuSeconds(time: string) {
  const [days, rest] = time.includes('-') ? time.split('-') : ['0', time];
  return (
    Number(days) * 86_400 + rest!.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  );
}

// --- Devices ---------------------------------------------------------------------------------

type Message = { type: string; requestId?: string; payload: Record<string, unknown> };

class Device {
  readonly id: string;
  readonly user: string;
  readonly namespace: string;
  readonly ip: string;
  readonly server: Instance;
  socket?: WebSocket;
  closes = 0;
  #requests = 0;
  #pending = new Map<string, (message: Message) => void>();
  #listeners = new Set<(message: Message) => void>();

  constructor(index: number) {
    const user = Math.floor(index / perUser);
    this.id = `load-${index}`;
    this.user = `user-${user}`;
    this.namespace = `${appId}:load-${user}`;
    this.ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
    this.server = servers[index % servers.length]!;
  }

  /** Opens, authenticates, joins its namespace, and discovers it, retrying with the SDK's backoff. */
  async connect(): Promise<{ attempts: number; lastMs: number }> {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      try {
        await this.#open();
        const token = await mintDevToken({
          app_id: appId,
          sub: this.user,
          device_id: this.id,
          namespaces: [this.namespace],
        });
        await this.request('auth.authenticate', { token }, 'auth.result');
        await this.request('namespace.join', { namespace: this.namespace }, 'ack');
        await this.request('discovery.request', { namespace: this.namespace }, 'discovery.result');
        return { attempts: attempt + 1, lastMs: performance.now() - started };
      } catch (error) {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
        const retryAfter = error instanceof Rejected ? error.retryAfterMs : undefined;
        // Full jitter, 1 s base, 30 s cap: the SDK's defaults (docs/protocol.md §10).
        await sleep(retryAfter ?? Math.random() * Math.min(30_000, 1_000 * 2 ** attempt));
      }
    }
  }

  #open() {
    return new Promise<void>((resolve, reject_) => {
      const socket = new WebSocket(`ws://${host}:${this.server.port}`, {
        headers: { 'x-forwarded-for': this.ip },
      });
      this.socket = socket;
      socket.on('unexpected-response', (_request, response) => {
        reject(`http_${response.statusCode}`);
        // The server closes first, so TIME_WAIT stays on its side and the client's ports, 16k on
        // macOS, are not used up by retries.
        response.resume();
        reject_(new Error(`HTTP ${response.statusCode}`));
      });
      socket.on('error', (error) => {
        reject(`socket_${(error as NodeJS.ErrnoException).code ?? 'error'}`);
        reject_(error);
      });
      socket.on('open', () => resolve());
      socket.on('close', () => {
        this.closes++;
        for (const settle of this.#pending.values()) settle({ type: 'closed', payload: {} });
        this.#pending.clear();
      });
      socket.on('message', (data) => {
        const message = JSON.parse((data as Buffer).toString()) as Message;
        if (message.type === 'error') reject(String(message.payload.code));
        const settle = message.requestId ? this.#pending.get(message.requestId) : undefined;
        if (settle) {
          this.#pending.delete(message.requestId!);
          settle(message);
        }
        for (const listener of this.#listeners) listener(message);
      });
    });
  }

  send(type: string, payload: Record<string, unknown>) {
    const requestId = `r${++this.#requests}`;
    this.socket!.send(JSON.stringify({ version: PROTOCOL_VERSION, type, requestId, payload }));
    return requestId;
  }

  /** Sends a request and resolves with its reply; rejects on an error or a closed socket. */
  request(type: string, payload: Record<string, unknown>, reply: string) {
    return new Promise<Message>((resolve, reject_) => {
      this.#pending.set(this.send(type, payload), (message) => {
        if (message.type === reply) resolve(message);
        else reject_(new Rejected(message));
      });
    });
  }

  /** The next message of `type` that `match` accepts. */
  next(type: string, match: (message: Message) => boolean = () => true, timeoutMs = 30_000) {
    return new Promise<Message>((resolve, reject_) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        reject_(new Error(`${this.id}: no ${type} within ${timeoutMs} ms`));
      }, timeoutMs);
      const listener = (message: Message) => {
        if (message.type !== type || !match(message)) return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(message);
      };
      this.#listeners.add(listener);
    });
  }
}

class Rejected extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: Message) {
    super(`${message.type}: ${JSON.stringify(message.payload.code)}`);
    this.retryAfterMs = message.payload.retryAfterMs as number | undefined;
  }
}

// --- Phases ----------------------------------------------------------------------------------

/** Opens the fleet at `rate` connections per second. */
async function connectFleet(fleet: Device[]) {
  const started = performance.now();
  const results = await Promise.all(
    fleet.map(async (device, i) => {
      await sleep(Math.max(0, started + (i * 1000) / rate - performance.now()));
      return device.connect();
    }),
  );
  return {
    seconds: round((performance.now() - started) / 1000),
    retried: results.filter((r) => r.attempts > 1).length,
    connectMs: percentiles(results.map((r) => r.lastMs)),
  };
}

/** Each user's first two devices negotiate a session: offer, answer, and candidates each way. */
async function negotiate(fleet: Device[]) {
  const relayMs: number[] = [];
  const stamp = () => `t=${performance.now()}`;
  const age = (message: Message, field: string) =>
    performance.now() - Number(/t=([\d.]+)/.exec(String(message.payload[field]))![1]);
  const pairs = [];
  for (let i = 0; i + 1 < fleet.length; i += perUser)
    pairs.push([fleet[i]!, fleet[i + 1]!] as const);
  const started = performance.now();
  const outcomes = await Promise.allSettled(
    pairs.map(async ([caller, callee]) => {
      const requested = callee.next('session.request');
      const { payload } = await caller.request(
        'session.create',
        { namespace: caller.namespace, userId: callee.user, deviceId: callee.id },
        'session.created',
      );
      const sessionId = String(payload.sessionId);
      await requested;
      const accepted = caller.next('session.accepted');
      await callee.request('session.accept', { sessionId }, 'ack');
      await accepted;

      const offer = callee.next('rtc.offer');
      caller.send('rtc.offer', { sessionId, sdp: stamp().padEnd(sdpBytes, 'x') });
      relayMs.push(age(await offer, 'sdp'));
      const answer = caller.next('rtc.answer');
      callee.send('rtc.answer', { sessionId, sdp: stamp().padEnd(sdpBytes, 'x') });
      relayMs.push(age(await answer, 'sdp'));

      const trickle = async (from: Device, to: Device) => {
        let received = 0;
        const all = to.next('rtc.ice_candidate', (message) => {
          relayMs.push(age(message, 'candidate'));
          return ++received === candidates;
        });
        for (let c = 0; c < candidates; c++) {
          from.send('rtc.ice_candidate', {
            sessionId,
            candidate: `candidate:${c} 1 udp ${stamp()}`,
          });
        }
        await all;
      };
      await Promise.all([trickle(caller, callee), trickle(callee, caller)]);
      await caller.request('session.close', { sessionId }, 'ack');
    }),
  );
  const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
  return {
    sessions: pairs.length,
    failed: failed.length,
    firstFailure: failed[0] && String(failed[0].reason),
    seconds: round((performance.now() - started) / 1000),
    relayMs: percentiles(relayMs),
  };
}

/** Restarts every instance; the fleet reconnects as the SDK does, with fresh tokens. */
async function restart(fleet: Device[]) {
  const closed = fleet.flatMap((device) =>
    device.socket?.readyState === WebSocket.OPEN ? [once(device.socket, 'close')] : [],
  );
  await Promise.all(servers.map(stop));
  await Promise.all(closed);
  const down = performance.now();
  host = '[::1]';
  const reconnecting = fleet.map((device) => device.connect());
  await Promise.all(servers.map(start));
  const ready = performance.now();
  const results = await Promise.all(reconnecting);
  return {
    downSeconds: round((ready - down) / 1000),
    recoveredSeconds: round((performance.now() - ready) / 1000),
    attempts: percentiles(results.map((r) => r.attempts)),
  };
}

// --- Run -------------------------------------------------------------------------------------

const fleet = Array.from({ length: devices }, (_, i) => new Device(i));
let failed = false;
try {
  if (args['database-url']) {
    execFileSync(process.execPath, ['adapters/storage/postgresql/src/migrate-command.ts'], {
      cwd: root,
      env: { ...process.env, BLINDSIGNAL_DATABASE_URL: args['database-url'] },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }
  await Promise.all(servers.map(start));
  report('setup', {
    devices,
    rate,
    instances,
    candidates,
    sdpBytes,
    storage: Object.keys(storageEnv),
  });

  clientLoopP99();
  rejections.clear();
  report('fleet', {
    ...(await connectFleet(fleet)),
    rejections: Object.fromEntries(rejections),
    clientLoopP99Ms: clientLoopP99(),
    servers: await Promise.all(servers.map(sample)),
  });

  rejections.clear();
  await sleep(holdSeconds * 1000);
  report('hold', {
    seconds: holdSeconds,
    closed: fleet.filter((d) => d.closes > 0).length,
    rejections: Object.fromEntries(rejections),
    servers: await Promise.all(servers.map(sample)),
  });

  rejections.clear();
  const sessions = await negotiate(fleet);
  report('sessions', {
    ...sessions,
    rejections: Object.fromEntries(rejections),
    clientLoopP99Ms: clientLoopP99(),
    servers: await Promise.all(servers.map(sample)),
  });
  if (sessions.failed > 0) failed = true;

  rejections.clear();
  report('restart', {
    ...(await restart(fleet)),
    rejections: Object.fromEntries(rejections),
    servers: await Promise.all(servers.map(sample)),
  });
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const device of fleet) device.socket?.terminate();
  await Promise.all(servers.map(stop));
}
// The smoke run fails on any session that did not complete, so the script cannot rot in CI.
process.exitCode = failed ? 1 : 0;
