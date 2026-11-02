import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Level = 'info' | 'warn' | 'error';

/** Values a log line may carry; never a token, secret, or application payload (spec §18). */
export type LogFields = Readonly<Record<string, string | number | undefined>>;

export interface Logger {
  log(level: Level, event: string, fields?: LogFields): void;
}

/** One JSON object per line on stdout (docs/adr/0001: no logging dependency). */
export function jsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  return {
    log: (level, event, fields = {}) =>
      write(JSON.stringify({ time: now().toISOString(), level, event, ...fields })),
  };
}

const COUNTERS = {
  blindsignal_messages_total: 'Valid client messages received, by type.',
  blindsignal_errors_total: 'error messages sent, by code.',
  blindsignal_authentications_total: 'auth.authenticate outcomes: ok or the error code.',
  blindsignal_sessions_created_total: 'Sessions created.',
  blindsignal_sessions_terminated_total: 'Sessions terminated, by reason.',
  blindsignal_registry_reloads_total: 'Registry reloads: ok or rejected.',
} as const;

export type CounterName = keyof typeof COUNTERS;

// Label values come from closed catalogs (message types, error codes), so cardinality is bounded.
const escape = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

const labelSet = (labels: Readonly<Record<string, string>>) => {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${escape(value)}"`);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
};

/**
 * Process-local counters and gauges in the Prometheus text format.
 * shortcut: no OpenTelemetry and no per-application series; Phase 10 replaces this through an ADR,
 * and Phase 6 adds per-application usage metrics.
 */
export class Metrics {
  readonly #counters = new Map<CounterName, Map<string, number>>();
  readonly #gauges: { name: string; help: string; read: () => number }[] = [];

  count(name: CounterName, labels: Readonly<Record<string, string>> = {}): void {
    const series = this.#counters.get(name) ?? new Map<string, number>();
    const key = labelSet(labels);
    series.set(key, (series.get(key) ?? 0) + 1);
    this.#counters.set(name, series);
  }

  /** A gauge read when scraped. */
  gauge(name: string, help: string, read: () => number): void {
    this.#gauges.push({ name, help, read });
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, help] of Object.entries(COUNTERS)) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [labels, value] of this.#counters.get(name as CounterName) ?? []) {
        lines.push(`${name}${labels} ${value}`);
      }
    }
    for (const { name, help, read } of this.#gauges) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${read()}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

/**
 * Serves `GET /metrics` on the admin port, apart from the signaling port so it is never exposed
 * with it; 404 elsewhere. Resolves to the server and its bound port.
 */
export function serveMetrics(
  metrics: Pick<Metrics, 'render'>,
  port: number,
  host: string,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/metrics') {
      response
        .writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        .end(metrics.render());
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}
