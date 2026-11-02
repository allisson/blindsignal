import { readFile } from 'node:fs/promises';
import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import {
  InMemoryApplicationRepository,
  InMemoryDeviceRepository,
} from '@blindsignal/storage-memory';
import { loadConfig } from './config.ts';
import { TokenVerifier } from './domain/auth.ts';
import {
  parseRegistry,
  type ParseRegistryOptions,
  type RegistryResult,
} from './domain/registry.ts';
import { SessionRegistry } from './domain/sessions.ts';
import { SignalingServer } from './server.ts';
import { jsonLogger, Metrics, serveMetrics } from './telemetry.ts';

const logger = jsonLogger();

async function readRegistry(path: string, options: ParseRegistryOptions): Promise<RegistryResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // The path is operator configuration, not a secret; the error's message could quote more.
    return { ok: false, error: `cannot read the registry at ${path}` };
  }
  return parseRegistry(text, options);
}

/** Wires the adapters and starts the server; the only module that imports adapters (ADR 0002). */
async function main(): Promise<void> {
  const loaded = loadConfig(process.env);
  if (!loaded.ok) throw new Error(`invalid configuration: ${loaded.error}`);
  const config = loaded.config;
  const startedAt = new Date();
  const { registryPath, development } = config;

  const initial = await readRegistry(registryPath, { now: startedAt, development });
  if (!initial.ok) throw new Error(`invalid registry: ${initial.error}`);
  let registry = initial.registry;

  const applications = new InMemoryApplicationRepository();
  await applications.replaceAll(registry.applications);
  const coordination = new InMemoryCoordinationAdapter();
  const sessions = new SessionRegistry();
  const metrics = new Metrics();
  const server = new SignalingServer({
    allowedOrigins: config.allowedOrigins,
    proxyTrust: config.proxyTrust,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    preAuthentication: config.preAuthentication,
    coordination,
    connection: {
      verifier: new TokenVerifier({ applications, coordination, startedAt, ...config.token }),
      devices: new InMemoryDeviceRepository(),
      coordination,
      sessions,
      iceServers: config.iceServers.map(({ urls }) => ({ urls: [...urls] })),
      clockSkewSeconds: config.token.clockSkewSeconds,
      authenticationTimeoutMs: config.preAuthentication.authenticationTimeoutMs,
      authenticationAttempts: config.preAuthentication.authenticationAttempts,
      deviceTtlMs: config.deviceTtlMs,
      limits: config.limits,
      maxMessageBytes: config.maxMessageBytes,
      presenceLeaseMs: config.presenceLeaseMs,
      negotiationTimeoutMs: config.negotiationTimeoutMs,
      metrics,
      logger,
    },
  });
  metrics.gauge('blindsignal_connections', 'Open WebSocket connections.', () => server.connections);
  metrics.gauge('blindsignal_sessions', 'Sessions pending or active.', () => sessions.size);
  const port = await server.listen(config.port);
  const admin = await serveMetrics(metrics, config.adminPort, config.adminHost);
  logger.log('info', 'server.listening', { port, adminPort: admin.port });

  // All or nothing: a rejected reload keeps the current registry (ADR 0005).
  const reload = async () => {
    const next = await readRegistry(registryPath, {
      now: new Date(),
      previous: registry,
      development,
    });
    metrics.count('blindsignal_registry_reloads_total', { result: next.ok ? 'ok' : 'rejected' });
    if (!next.ok) {
      logger.log('warn', 'registry.reload_rejected', { reason: next.error });
      return;
    }
    registry = next.registry;
    await applications.replaceAll(registry.applications);
    await server.enforce(registry.applications);
    logger.log('info', 'registry.reloaded', { applications: registry.applications.length });
  };
  // One reload at a time, so each is checked against the registry the previous one installed.
  let reloading = Promise.resolve();
  process.on('SIGHUP', () => {
    reloading = reloading.then(reload);
  });

  const shutdown = async () => {
    logger.log('info', 'server.draining');
    await server.drain();
    await server.close();
    admin.server.close();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown().finally(() => process.exit(0)));
  }
}

main().catch((error: unknown) => {
  // Configuration and registry errors name keys, never values.
  const reason = error instanceof Error ? error.message : 'startup failed';
  logger.log('error', 'server.start_failed', { reason });
  process.exit(1);
});
