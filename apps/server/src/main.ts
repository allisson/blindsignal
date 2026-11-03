import { readFile } from 'node:fs/promises';
import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import type { StorageAdapter } from '@blindsignal/core';
import {
  InMemoryApplicationRepository,
  InMemoryDeviceRepository,
} from '@blindsignal/storage-memory';
import { openPostgreSQLStorage } from '@blindsignal/storage-postgresql';
import { loadConfig } from './config.ts';
import { TokenVerifier } from './domain/auth.ts';
import {
  parseRegistry,
  storedRegistry,
  type ParseRegistryOptions,
  type Registry,
  type RegistryResult,
} from './domain/registry.ts';
import { sweepDevices } from './domain/retention.ts';
import { AbuseMonitor } from './domain/abuse.ts';
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

  // Token verification reads the registry from this copy, never from the database (ADR 0021).
  const applications = new InMemoryApplicationRepository();
  let storage: StorageAdapter = { applications, devices: new InMemoryDeviceRepository() };
  let closeStorage = () => Promise.resolve();
  if (config.database !== undefined) {
    const postgres = openPostgreSQLStorage({
      ...config.database,
      onError: () => logger.log('warn', 'storage.connection_lost'),
    });
    await postgres.checkSchema();
    storage = postgres.storage;
    closeStorage = () => postgres.end();
  }
  logger.log('info', 'storage.ready', {
    storage: config.database === undefined ? 'memory' : 'postgresql',
  });
  // Stored first: a registry that cannot be stored is not installed.
  const install = async (next: Registry) => {
    await storage.applications.replaceAll(next.applications);
    if (storage.applications !== applications) await applications.replaceAll(next.applications);
  };

  const initial = await readRegistry(registryPath, {
    now: startedAt,
    previous: await storedRegistry(storage.applications),
    development,
  });
  if (!initial.ok) throw new Error(`invalid registry: ${initial.error}`);
  let registry = initial.registry;
  await install(registry);

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
      devices: storage.devices,
      coordination,
      sessions,
      iceServers: config.iceServers.map(({ urls }) => ({ urls: [...urls] })),
      ...(config.turn === undefined ? {} : { turn: config.turn }),
      clockSkewSeconds: config.token.clockSkewSeconds,
      authenticationTimeoutMs: config.preAuthentication.authenticationTimeoutMs,
      authenticationAttempts: config.preAuthentication.authenticationAttempts,
      deviceTtlMs: config.deviceTtlMs,
      limits: config.limits,
      maxMessageBytes: config.maxMessageBytes,
      maxQueuedMessages: config.maxQueuedMessages,
      maxBufferedBytes: config.maxBufferedBytes,
      presenceLeaseMs: config.presenceLeaseMs,
      negotiationTimeoutMs: config.negotiationTimeoutMs,
      abuse: new AbuseMonitor(config.abuseAlerts),
      metrics,
      logger,
    },
  });
  metrics.gauge('blindsignal_connections', 'Open WebSocket connections.', () => server.connections);
  metrics.gauge('blindsignal_sessions', 'Sessions pending or active.', () => sessions.size);
  metrics.labeledGauge(
    'blindsignal_application_connections',
    'Authenticated connections, by application.',
    'app_id',
    () => server.connectionsByApplication(),
  );
  metrics.labeledGauge(
    'blindsignal_application_sessions',
    'Sessions pending or active, by application.',
    'app_id',
    () => sessions.byApplication(),
  );
  const port = await server.listen(config.port);
  const admin = await serveMetrics(metrics, config.adminPort, config.adminHost);
  logger.log('info', 'server.listening', { port, adminPort: admin.port });

  const stopSweep = sweepDevices(
    storage.devices,
    { intervalMs: config.deviceSweepIntervalMs, ttlMs: config.deviceTtlMs },
    logger,
  );

  // All or nothing: a rejected reload keeps the current registry (ADR 0005).
  const reload = async () => {
    let next: RegistryResult;
    try {
      next = await readRegistry(registryPath, {
        now: new Date(),
        previous: await storedRegistry(storage.applications, registry),
        development,
      });
      if (next.ok) await install(next.registry);
    } catch {
      next = { ok: false, error: 'the registry could not be read from or written to storage' };
    }
    metrics.count('blindsignal_registry_reloads_total', { result: next.ok ? 'ok' : 'rejected' });
    if (!next.ok) {
      logger.log('warn', 'registry.reload_rejected', { reason: next.error });
      return;
    }
    registry = next.registry;
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
    stopSweep();
    await closeStorage();
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
