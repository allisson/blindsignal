import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { dependencyProbe, jsonLogger, Metrics, serveMetrics } from './telemetry.ts';

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
});

describe('Metrics', () => {
  it('renders every counter, its series, and the gauges in the Prometheus text format', () => {
    const metrics = new Metrics();
    metrics.count('blindsignal_errors_total', { code: 'not_authorized' });
    metrics.count('blindsignal_errors_total', { code: 'not_authorized' });
    metrics.count('blindsignal_errors_total', { code: 'a"b\\c\nd' });
    metrics.count('blindsignal_sessions_created_total');
    let open = 3;
    metrics.gauge('blindsignal_connections', 'Open WebSocket connections.', () => open);
    open = 4;
    const text = metrics.render();
    expect(text).toContain(
      [
        '# HELP blindsignal_errors_total error messages sent, by code.',
        '# TYPE blindsignal_errors_total counter',
        'blindsignal_errors_total{code="not_authorized"} 2',
        'blindsignal_errors_total{code="a\\"b\\\\c\\nd"} 1',
      ].join('\n'),
    );
    expect(text).toContain('blindsignal_sessions_created_total 1\n');
    // A counter never incremented still declares itself.
    expect(text).toContain('# TYPE blindsignal_registry_reloads_total counter\n');
    expect(text).toMatch(/# TYPE blindsignal_connections gauge\nblindsignal_connections 4\n$/);
  });

  it('renders a labeled gauge with one series per value', () => {
    const metrics = new Metrics();
    const counts = new Map([['notes', 2]]);
    metrics.labeledGauge('blindsignal_application_sessions', 'By app.', 'app_id', () => counts);
    counts.set('chat', 1);
    expect(metrics.render()).toMatch(
      /# TYPE blindsignal_application_sessions gauge\nblindsignal_application_sessions\{app_id="notes"\} 2\nblindsignal_application_sessions\{app_id="chat"\} 1\n$/,
    );
  });
});

describe('dependencyProbe', () => {
  const header = [
    '# HELP blindsignal_dependency_up Whether the dependency answered a probe within the timeout: 1 or 0.',
    '# TYPE blindsignal_dependency_up gauge',
  ];

  it('reports 1 for a check that resolves and 0 for one that rejects or throws', async () => {
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
    expect(await probe()).toBe(
      [
        ...header,
        'blindsignal_dependency_up{dependency="postgresql"} 1',
        'blindsignal_dependency_up{dependency="redis"} 0',
        'blindsignal_dependency_up{dependency="other"} 0',
        '',
      ].join('\n'),
    );
  });

  it('declares the gauge with no series when nothing is probed', async () => {
    expect(await dependencyProbe({}, 1_000)()).toBe([...header, ''].join('\n'));
  });

  it('reports 0 for a check past the timeout and runs it once until it settles', async () => {
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
    expect(await probe()).toContain('blindsignal_dependency_up{dependency="postgresql"} 0\n');
    expect(await probe()).toContain('blindsignal_dependency_up{dependency="postgresql"} 0\n');
    expect(calls).toBe(1);
    // The check still running answers the scrape that finds it settling.
    const pending = probe();
    settle();
    expect(await pending).toContain('blindsignal_dependency_up{dependency="postgresql"} 1\n');
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
    const served = await serveMetrics({ render: () => 'm 1\n' }, 0, '127.0.0.1');
    server = served.server;
    const base = `http://127.0.0.1:${served.port}`;
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(await metrics.text()).toBe('m 1\n');
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
  });

  it('serves what an asynchronous render resolves to', async () => {
    const served = await serveMetrics({ render: () => Promise.resolve('m 2\n') }, 0, '127.0.0.1');
    server = served.server;
    expect(await (await fetch(`http://127.0.0.1:${served.port}/metrics`)).text()).toBe('m 2\n');
  });

  it('rejects when the port is taken', async () => {
    const served = await serveMetrics({ render: () => '' }, 0, '127.0.0.1');
    server = served.server;
    await expect(serveMetrics({ render: () => '' }, served.port, '127.0.0.1')).rejects.toThrow();
  });
});
