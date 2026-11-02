import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { jsonLogger, Metrics, serveMetrics } from './telemetry.ts';

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

  it('rejects when the port is taken', async () => {
    const served = await serveMetrics({ render: () => '' }, 0, '127.0.0.1');
    server = served.server;
    await expect(serveMetrics({ render: () => '' }, served.port, '127.0.0.1')).rejects.toThrow();
  });
});
