import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  dependencyProbe,
  jsonLogger,
  logCrash,
  Metrics,
  OTLPExporter,
  serveMetrics,
  watchProcess,
} from './telemetry.ts';

const release = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

describe('jsonLogger', () => {
  it('writes one JSON object per line with time, level, and event first', () => {
    const lines: string[] = [];
    const logger = jsonLogger(
      (line) => lines.push(line),
      () => new Date('2026-11-02T00:00:00Z'),
    );
    logger.log('warn', 'registry.reload_rejected', { reason: 'x', skipped: undefined });
    expect(lines).toEqual([
      '{"time":"2026-11-02T00:00:00.000Z","level":"warn","event":"registry.reload_rejected","reason":"x"}',
    ]);
  });

  it('writes only the events at the minimum level or above', () => {
    const events: string[] = [];
    const write = (line: string) => events.push((JSON.parse(line) as { event: string }).event);
    for (const [minimum, expected] of [
      ['info', ['i', 'w', 'e']],
      ['warn', ['w', 'e']],
      ['error', ['e']],
    ] as const) {
      events.length = 0;
      const logger = jsonLogger(write, undefined, minimum);
      logger.log('info', 'i');
      logger.log('warn', 'w');
      logger.log('error', 'e');
      expect(events).toEqual(expected);
    }
  });
});

describe('logCrash', () => {
  const crash = (error: unknown) => {
    const logs: object[] = [];
    logCrash({ log: (level, event, fields) => logs.push({ level, event, ...fields }) }, error, 'o');
    return logs;
  };

  it('logs the name and the stack frames, never the message', () => {
    const error = new TypeError('secret-value\nat a second line');
    error.stack = `TypeError: secret-value\nat a second line\n    at f (/app/a.ts:1:2)\n    at g (/app/b.ts:3:4)`;
    expect(crash(error)).toEqual([
      {
        level: 'error',
        event: 'server.crashed',
        origin: 'o',
        reason: 'TypeError',
        stack: 'at f (/app/a.ts:1:2)\nat g (/app/b.ts:3:4)',
      },
    ]);
  });

  it('drops a line of the message that looks like a frame', () => {
    const error = new Error('one\n    at secret-value (x)');
    error.stack = `Error: one\n    at secret-value (x)\n    at f (/app/a.ts:1:2)`;
    expect(crash(error)).toMatchObject([{ stack: 'at f (/app/a.ts:1:2)' }]);
  });

  it('logs no stack when it does not start with the message', () => {
    const error = new Error('changed');
    error.stack = `Error: before\n    at secret-value (x)`;
    expect(crash(error)).toMatchObject([{ reason: 'Error', stack: undefined }]);
  });

  it('logs the type of a value thrown that is not an error, with no stack', () => {
    expect(crash('secret-value')).toEqual([
      { level: 'error', event: 'server.crashed', origin: 'o', reason: 'string', stack: undefined },
    ]);
  });
});

describe('Metrics', () => {
  it('renders the counters and the gauges in the Prometheus text format', async () => {
    const metrics = new Metrics();
    metrics.count('blindsignal_errors_total', { code: 'not_authorized' });
    metrics.count('blindsignal_errors_total', { code: 'not_authorized' });
    metrics.count('blindsignal_errors_total', { code: 'a"b\\c\nd' });
    metrics.count('blindsignal_sessions_created_total');
    let open = 3;
    metrics.gauge('blindsignal_connections', 'Open WebSocket connections.', () => open);
    open = 4;
    const text = await metrics.render();
    expect(text).toContain(
      [
        '# HELP blindsignal_errors_total error messages sent, by code.',
        '# TYPE blindsignal_errors_total counter',
        'blindsignal_errors_total{code="not_authorized"} 2',
        'blindsignal_errors_total{code="a\\"b\\\\c\\nd"} 1',
      ].join('\n'),
    );
    expect(text).toContain('blindsignal_sessions_created_total 1\n');
    expect(text).toContain('# TYPE blindsignal_connections gauge\nblindsignal_connections 4\n');
    // Neither the resource nor the instrumentation scope reaches the series (ADR 0038).
    expect(text).not.toContain('target_info');
    expect(text).not.toContain('otel_scope');
    metrics.count('blindsignal_devices_expired_total', {}, 5);
    metrics.count('blindsignal_devices_expired_total', {}, 2);
    expect(await metrics.render()).toContain('blindsignal_devices_expired_total 7\n');
  });

  it('renders a labeled gauge with one series per value, read asynchronously', async () => {
    const metrics = new Metrics();
    const counts = new Map([['notes', 2]]);
    metrics.labeledGauge('blindsignal_application_sessions', 'By app.', 'app_id', () =>
      Promise.resolve(counts),
    );
    counts.set('chat', 1);
    const text = await metrics.render();
    expect(text).toContain('blindsignal_application_sessions{app_id="notes"} 2\n');
    expect(text).toContain('blindsignal_application_sessions{app_id="chat"} 1\n');
  });

  it('renders a histogram in seconds with its buckets, by label', async () => {
    const metrics = new Metrics();
    metrics.observe('blindsignal_authentication_duration_seconds', 0.03, { result: 'ok' });
    metrics.observe('blindsignal_authentication_duration_seconds', 2, { result: 'ok' });
    metrics.observe('blindsignal_session_acceptance_seconds', 45);
    const text = await metrics.render();
    for (const line of [
      '# TYPE blindsignal_authentication_duration_seconds histogram',
      'blindsignal_authentication_duration_seconds_count{result="ok"} 2',
      'blindsignal_authentication_duration_seconds_sum{result="ok"} 2.03',
      'blindsignal_authentication_duration_seconds_bucket{result="ok",le="0.025"} 0',
      'blindsignal_authentication_duration_seconds_bucket{result="ok",le="0.05"} 1',
      'blindsignal_authentication_duration_seconds_bucket{result="ok",le="2.5"} 2',
      'blindsignal_authentication_duration_seconds_bucket{result="ok",le="10"} 2',
      'blindsignal_session_acceptance_seconds_bucket{le="30"} 0',
      'blindsignal_session_acceptance_seconds_bucket{le="60"} 1',
    ]) {
      expect(text).toContain(`${line}\n`);
    }
  });

  it('pushes to the exporter every interval, with the instance as a resource', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const metrics = new Metrics({ exporter, intervalMs: 20 });
    try {
      metrics.count('blindsignal_sessions_created_total', {}, 3);
      await vi.waitFor(() => expect(exporter.getMetrics().length).toBeGreaterThan(0));
      const [exported] = exporter.getMetrics();
      const names = exported?.scopeMetrics.flatMap(({ metrics }) =>
        metrics.map(({ descriptor }) => descriptor.name),
      );
      expect(names).toContain('blindsignal_sessions_created_total');
      const attributes = exported?.resource.attributes ?? {};
      expect(attributes['service.name']).toBe('blindsignal');
      expect(attributes['service.version']).toBe(release);
      expect(attributes['service.instance.id']).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await metrics.shutdown();
    }
  });

  it('pushes what is left on shutdown', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const metrics = new Metrics({ exporter, intervalMs: 60_000 });
    metrics.count('blindsignal_registry_reloads_total', { result: 'ok' });
    const other = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const second = new Metrics({ exporter: other, intervalMs: 60_000 });
    second.count('blindsignal_registry_reloads_total', { result: 'ok' });
    await Promise.all([metrics.shutdown(), second.shutdown()]);
    // Each instance names itself, so a backend keeps two instances' series apart.
    const instance = (from: InMemoryMetricExporter) =>
      from.getMetrics()[0]?.resource.attributes['service.instance.id'];
    expect(instance(other)).toMatch(/^[0-9a-f-]{36}$/);
    expect(instance(exporter)).not.toBe(instance(other));
    const names = exporter
      .getMetrics()
      .flatMap(({ scopeMetrics }) => scopeMetrics)
      .flatMap(({ metrics }) => metrics.map(({ descriptor }) => descriptor.name));
    expect(names).toContain('blindsignal_registry_reloads_total');
  });
});

describe('OTLPExporter', () => {
  it('logs a failed export without its error, and passes the result on', async () => {
    const logs: object[] = [];
    const exporter = new OTLPExporter(
      { log: (level, event, fields) => logs.push({ level, event, ...fields }) },
      // Nothing listens on port 1.
      { url: 'http://127.0.0.1:1/v1/metrics', timeoutMillis: 2_000 },
    );
    const reader = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const metrics = new Metrics({ exporter: reader, intervalMs: 60_000 });
    metrics.count('blindsignal_sessions_created_total');
    await metrics.shutdown();
    const [resourceMetrics] = reader.getMetrics();
    const result = await new Promise<{ code: number }>((resolve) =>
      exporter.export(resourceMetrics as ResourceMetrics, resolve),
    );
    expect(result.code).not.toBe(0);
    expect(logs).toEqual([{ level: 'warn', event: 'telemetry.export_failed' }]);
    await exporter.shutdown();
  });
});

describe('watchProcess', () => {
  const value = (text: string, series: string) =>
    Number(new RegExp(`^${series.replace(/[{}]/g, '\\$&')} (\\S+)$`, 'm').exec(text)?.[1]);

  it('reports the start time, memory, and the event loop delay since the previous scrape', async () => {
    const metrics = new Metrics();
    const stop = watchProcess(metrics);
    try {
      // The monitor's timer starts with the event loop's next turn.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const blocked = Date.now();
      while (Date.now() - blocked < 120) {
        // Blocks the event loop.
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const text = await metrics.render();
      expect(value(text, 'process_start_time_seconds')).toBe(performance.timeOrigin / 1000);
      expect(value(text, 'process_resident_memory_bytes')).toBeGreaterThan(0);
      expect(value(text, 'nodejs_heap_size_used_bytes')).toBeGreaterThan(0);
      expect(value(text, 'nodejs_eventloop_delay_seconds{stat="max"}')).toBeGreaterThanOrEqual(0.1);
      expect(value(text, 'nodejs_eventloop_delay_seconds{stat="p99"}')).toBeGreaterThan(0);
      // The block is behind the previous scrape.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        value(await metrics.render(), 'nodejs_eventloop_delay_seconds{stat="max"}'),
      ).toBeLessThan(0.1);
    } finally {
      stop();
    }
  });
});

describe('dependencyProbe', () => {
  it('reads 1 for a check that resolves and 0 for one that rejects or throws', async () => {
    const probe = dependencyProbe(
      {
        postgresql: () => Promise.resolve(),
        redis: () => Promise.reject(new Error('ECONNREFUSED')),
        other: () => {
          throw new Error('sync');
        },
      },
      1_000,
    );
    expect(await probe()).toEqual(
      new Map([
        ['postgresql', 1],
        ['redis', 0],
        ['other', 0],
      ]),
    );
  });

  it('reads nothing when nothing is probed', async () => {
    expect(await dependencyProbe({}, 1_000)()).toEqual(new Map());
  });

  it('reads 0 for a check past the timeout and runs it once until it settles', async () => {
    let calls = 0;
    let settle = () => {};
    const probe = dependencyProbe(
      {
        postgresql: () => {
          calls++;
          return new Promise<void>((resolve) => (settle = resolve));
        },
      },
      20,
    );
    expect(await probe()).toEqual(new Map([['postgresql', 0]]));
    expect(await probe()).toEqual(new Map([['postgresql', 0]]));
    expect(calls).toBe(1);
    // The check still running answers the scrape that finds it settling.
    const pending = probe();
    settle();
    expect(await pending).toEqual(new Map([['postgresql', 1]]));
    expect(calls).toBe(1);
    // Once settled, the next scrape runs a new check.
    await probe();
    expect(calls).toBe(2);
  });
});

describe('serveMetrics', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('serves GET /metrics on the given host and 404 elsewhere', async () => {
    const served = await serveMetrics({ render: () => Promise.resolve('m 1\n') }, 0, '127.0.0.1');
    server = served.server;
    const base = `http://127.0.0.1:${served.port}`;
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(await metrics.text()).toBe('m 1\n');
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
  });

  it('rejects when the port is taken', async () => {
    const render = () => Promise.resolve('');
    const served = await serveMetrics({ render }, 0, '127.0.0.1');
    server = served.server;
    await expect(serveMetrics({ render }, served.port, '127.0.0.1')).rejects.toThrow();
  });
});
