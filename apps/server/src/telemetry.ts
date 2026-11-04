import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

/** In increasing severity. */
export const levels = ['info', 'warn', 'error'] as const;
export type Level = (typeof levels)[number];

/** Values a log line may carry; never a token, secret, or application payload (spec §18). */
export type LogFields = Readonly<Record<string, string | number | undefined>>;

export interface Logger {
  log(level: Level, event: string, fields?: LogFields): void;
}

/**
 * One JSON object per line on stdout (docs/adr/0001: no logging dependency), for the events at
 * `minimum` or above (ADR 0037).
 */
export function jsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
  minimum: Level = 'info',
): Logger {
  return {
    log: (level, event, fields = {}) => {
      if (levels.indexOf(level) < levels.indexOf(minimum)) return;
      write(JSON.stringify({ time: now().toISOString(), level, event, ...fields }));
    },
  };
}

/**
 * Logs an uncaught exception or unhandled rejection as `server.crashed`: the error's name and
 * stack frames, never its message, which may quote values (ADR 0037).
 */
export function logCrash(logger: Logger, error: unknown, origin: string): void {
  // The stack starts with the name and the message, whose lines may look like frames.
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  const header = error instanceof Error ? String(error) : '';
  const frames = stack.startsWith(header)
    ? stack
        .slice(header.length)
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
        .map((line) => line.trim())
    : [];
  logger.log('error', 'server.crashed', {
    origin,
    reason: error instanceof Error ? error.name : typeof error,
    stack: frames.length === 0 ? undefined : frames.join('\n'),
  });
}

const COUNTERS = {
  blindsignal_messages_total: 'Valid client messages received, by type.',
  blindsignal_errors_total: 'error messages sent, by code.',
  blindsignal_authentications_total: 'auth.authenticate outcomes: ok or the error code.',
  blindsignal_sessions_created_total: 'Sessions created.',
  blindsignal_sessions_terminated_total: 'Sessions terminated, by reason.',
  blindsignal_pairings_total:
    'Pairing requests that ended, by result: approved, rejected, or timeout.',
  blindsignal_registry_reloads_total: 'Registry reloads: ok or rejected.',
  blindsignal_overloaded_connections_total:
    'Connections closed with 1013, by the limit reached: queued_messages or buffered_bytes.',
  blindsignal_application_messages_total:
    'Valid client messages received from authenticated connections, by application.',
  blindsignal_application_errors_total:
    'error messages sent once the token is verified, by application and code.',
  blindsignal_application_sessions_created_total: 'Sessions created, by application.',
  blindsignal_abuse_alerts_total:
    'Abuse alerts: rate_limited and quota_exceeded rejections reaching the threshold in a window, by application.',
  blindsignal_turn_credentials_issued_total:
    'TURN credentials sent in rtc.ice_config, by application.',
  blindsignal_devices_expired_total: 'Device records deleted by the retention sweep.',
  blindsignal_coordination_events_dropped_total:
    'Events between connections dropped, by reason: invalid, matching no schema; stale, not matching the receiving copy; or overloaded, an rtc.* message for a connection whose send buffer is half full.',
} as const;

export type CounterName = keyof typeof COUNTERS;

const HISTOGRAMS = {
  blindsignal_authentication_duration_seconds: {
    description:
      'auth.authenticate from its receipt to the reply, by result: ok or the error code.',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
  blindsignal_session_acceptance_seconds: {
    description: 'Sessions from session.create to session.accepted, measured by the requester.',
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  },
} as const;

export type HistogramName = keyof typeof HISTOGRAMS;

type Labels = Readonly<Record<string, string>>;

/** Calls `done` with the export's result, and logs a failure without its error (ADR 0038). */
export class OTLPExporter extends OTLPMetricExporter {
  readonly #logger: Logger;

  constructor(logger: Logger, config?: ConstructorParameters<typeof OTLPMetricExporter>[0]) {
    super(config);
    this.#logger = logger;
  }

  override export(metrics: ResourceMetrics, done: (result: ExportResult) => void): void {
    super.export(metrics, (result) => {
      // The error can quote the endpoint's response; the event alone is enough to alert on.
      if (result.code !== ExportResultCode.SUCCESS)
        this.#logger.log('warn', 'telemetry.export_failed');
      done(result);
    });
  }
}

/**
 * Counters, gauges, and histograms through the OpenTelemetry metrics SDK (ADR 0038): rendered in
 * the Prometheus text format for `/metrics`, and pushed to `exporter` every `intervalMs` when one
 * is given. Label values come from closed catalogs (message types, error codes) or the registry's
 * application IDs, so cardinality is bounded (ADR 0015).
 */
export class Metrics {
  readonly #prometheus = new PrometheusExporter({ preventServerStart: true });
  readonly #serializer = new PrometheusSerializer('', false, undefined, true, true);
  readonly #provider: MeterProvider;
  readonly #meter: Meter;
  readonly #counters: ReadonlyMap<string, Counter>;
  readonly #histograms: ReadonlyMap<string, Histogram>;

  constructor(push?: { exporter: PushMetricExporter; intervalMs: number }) {
    const readers: MetricReader[] = [this.#prometheus];
    if (push !== undefined) {
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: push.exporter,
          exportIntervalMillis: push.intervalMs,
          exportTimeoutMillis: Math.min(push.intervalMs, 30_000),
        }),
      );
    }
    this.#provider = new MeterProvider({
      // Each process is its own instance, so a backend keeps the instances' series apart.
      resource: resourceFromAttributes({
        'service.name': 'blindsignal',
        'service.instance.id': crypto.randomUUID(),
      }),
      readers,
    });
    const meter = this.#provider.getMeter('blindsignal');
    this.#meter = meter;
    this.#counters = new Map(
      Object.entries(COUNTERS).map(([name, description]) => [
        name,
        meter.createCounter(name, { description }),
      ]),
    );
    this.#histograms = new Map(
      Object.entries(HISTOGRAMS).map(([name, { description, buckets }]) => [
        name,
        meter.createHistogram(name, {
          description,
          unit: 's',
          advice: { explicitBucketBoundaries: [...buckets] },
        }),
      ]),
    );
  }

  count(name: CounterName, labels: Labels = {}, by = 1): void {
    this.#counters.get(name)?.add(by, labels);
  }

  observe(name: HistogramName, seconds: number, labels: Labels = {}): void {
    this.#histograms.get(name)?.record(seconds, labels);
  }

  /** A gauge read on every collection: a scrape or an export. */
  gauge(name: string, help: string, read: () => number): void {
    this.#meter
      .createObservableGauge(name, { description: help })
      .addCallback((result) => result.observe(read()));
  }

  /** A gauge with one series per value of `label`, read on every collection. */
  labeledGauge(
    name: string,
    help: string,
    label: string,
    read: () => ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number>>,
  ): void {
    this.#meter.createObservableGauge(name, { description: help }).addCallback(async (result) => {
      for (const [key, value] of await read()) result.observe(value, { [label]: key });
    });
  }

  async render(): Promise<string> {
    const { resourceMetrics } = await this.#prometheus.collect();
    return this.#serializer.serialize(resourceMetrics);
  }

  /**
   * Pushes what is left to the exporter, if any, and stops the periodic export; rejects past
   * `timeoutMs`.
   */
  shutdown(timeoutMs?: number): Promise<void> {
    return this.#provider.shutdown(
      timeoutMs === undefined ? undefined : { timeoutMillis: timeoutMs },
    );
  }
}

/**
 * Registers the process's gauges (ADR 0037): its start time, its memory, and the event loop's delay
 * since the previous scrape, so one scraper reads the delay over its own interval. Returns a
 * function that stops the event loop monitor.
 */
export function watchProcess(metrics: Metrics): () => void {
  const delay = monitorEventLoopDelay();
  delay.enable();
  metrics.gauge(
    'process_start_time_seconds',
    'Start time of the process since the Unix epoch, in seconds.',
    () => performance.timeOrigin / 1000,
  );
  metrics.gauge('process_resident_memory_bytes', 'Resident memory size, in bytes.', () =>
    process.memoryUsage.rss(),
  );
  metrics.gauge(
    'nodejs_heap_size_used_bytes',
    'V8 heap in use, in bytes.',
    () => process.memoryUsage().heapUsed,
  );
  metrics.labeledGauge(
    'nodejs_eventloop_delay_seconds',
    'Event loop delay since the previous scrape, in seconds: its 99th percentile and maximum.',
    'stat',
    () => {
      const stats = new Map([
        ['p99', delay.percentile(99) / 1e9],
        ['max', delay.max / 1e9],
      ]);
      delay.reset();
      return stats;
    },
  );
  return () => delay.disable();
}

/**
 * Reads `blindsignal_dependency_up`: 1 for each dependency whose check resolves within
 * `timeoutMs`, 0 otherwise (ADR 0028). A check still running from an earlier collection is awaited
 * again rather than started twice, so a dependency that hangs holds one check, not one per scrape.
 */
export function dependencyProbe(
  checks: Readonly<Record<string, () => Promise<void>>>,
  timeoutMs: number,
): () => Promise<ReadonlyMap<string, number>> {
  const running = new Map<string, Promise<boolean>>();
  const check = (name: string, run: () => Promise<void>) => {
    let result = running.get(name);
    if (result === undefined) {
      result = Promise.resolve()
        .then(run)
        .then(
          () => true,
          () => false,
        );
      running.set(name, result);
      void result.then(() => running.delete(name));
    }
    return result;
  };
  const within = async (result: Promise<boolean>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>(
      (resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)),
    );
    try {
      return await Promise.race([result, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  return async () =>
    new Map(
      await Promise.all(
        Object.entries(checks).map(
          async ([dependency, run]) =>
            [dependency, (await within(check(dependency, run))) ? 1 : 0] as const,
        ),
      ),
    );
}

/**
 * Serves `GET /metrics` on the admin port, apart from the signaling port so it is never exposed
 * with it; 404 elsewhere. Resolves to the server and its bound port.
 */
export function serveMetrics(
  metrics: { render(): Promise<string> },
  port: number,
  host: string,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/metrics') {
      void metrics
        .render()
        .then((text) =>
          response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(text),
        );
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
