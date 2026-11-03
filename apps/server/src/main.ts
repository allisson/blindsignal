import { readFile } from 'node:fs/promises';
import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import { openRedisCoordination } from '@blindsignal/coordination-redis';
import type { ApplicationRepository, CoordinationAdapter, StorageAdapter } from '@blindsignal/core';
import {
  InMemoryApplicationRepository,
  InMemoryDeviceRepository,
} from '@blindsignal/storage-memory';
import { openPostgreSQLStorage } from '@blindsignal/storage-postgresql';
import { loadConfig } from './config.ts';
import { TokenVerifier } from './domain/auth.ts';
import {
  followRegistry,
  REGISTRY_CHANGED,
  REGISTRY_TOPIC,
  storeRegistry,
  syncRegistry,
  type Registry,
  type RegistryResult,
} from './domain/registry.ts';
import { sweepDevices } from './domain/retention.ts';
import { AbuseMonitor } from './domain/abuse.ts';
import { SignalingServer } from './server.ts';
import {
  dependencyProbe,
  jsonLogger,
  logCrash,
  Metrics,
  serveMetrics,
  watchProcess,
} from './telemetry.ts';

// At every level until the configuration sets one.
let logger = jsonLogger();

// Uncaught errors, unhandled rejections included, still end the process, logged as JSON (ADR 0037).
process.on('uncaughtException', (error, origin) => {
  logCrash(logger, error, origin);
  process.exit(1);
});

async function readRegistry(
  path: string,
  stored: ApplicationRepository,
  options: Parameters<typeof storeRegistry>[2],
): Promise<RegistryResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // The path is operator configuration, not a secret; the error's message could quote more.
    return { ok: false, error: `cannot read the registry at ${path}` };
  }
  return storeRegistry(text, stored, options);
}

/** Wires the adapters and starts the server; the only module that imports adapters (ADR 0002). */
async function main(): Promise<void> {
  const loaded = loadConfig(process.env);
  if (!loaded.ok) throw new Error(`invalid configuration: ${loaded.error}`);
  const config = loaded.config;
  logger = jsonLogger(undefined, undefined, config.logLevel);
  const startedAt = new Date();
  const { registryPath, development } = config;

  // Token verification reads the registry from this copy, never from the database (ADR 0021).
  const applications = new InMemoryApplicationRepository();
  let storage: StorageAdapter = { applications, devices: new InMemoryDeviceRepository() };
  let closeStorage = () => Promise.resolve();
  // Probed on every scrape of /metrics, never for readiness (ADR 0028).
  const dependencies: Record<string, () => Promise<void>> = {};
  if (config.database !== undefined) {
    const postgres = openPostgreSQLStorage({
      ...config.database,
      onError: () => logger.log('warn', 'storage.connection_lost'),
    });
    await postgres.checkSchema();
    storage = postgres.storage;
    closeStorage = () => postgres.end();
    dependencies.postgresql = () => postgres.ping();
  }
  logger.log('info', 'storage.ready', {
    storage: config.database === undefined ? 'memory' : 'postgresql',
  });
  // Copies what `readRegistry` stored; a registry that cannot be stored is not installed.
  const install = async (next: Registry) => {
    if (storage.applications !== applications) await applications.replaceAll(next.applications);
  };

  const initial = await readRegistry(registryPath, storage.applications, {
    now: startedAt,
    development,
  });
  if (!initial.ok) throw new Error(`invalid registry: ${initial.error}`);
  let registry = initial.registry;
  await install(registry);

  let coordination: CoordinationAdapter = new InMemoryCoordinationAdapter();
  let closeCoordination = () => Promise.resolve();
  if (config.redis !== undefined) {
    const redis = await openRedisCoordination({
      ...config.redis,
      onError: () => logger.log('warn', 'coordination.connection_lost'),
    });
    coordination = redis.coordination;
    closeCoordination = () => redis.end();
    dependencies.redis = () => redis.ping();
  }
  logger.log('info', 'coordination.ready', {
    coordination: config.redis === undefined ? 'memory' : 'redis',
  });
  const metrics = new Metrics();
  const server = new SignalingServer({
    allowedOrigins: config.allowedOrigins,
    proxyTrust: config.proxyTrust,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    maxConnectionMs: config.maxConnectionMs,
    maxConnections: config.maxConnections,
    preAuthentication: config.preAuthentication,
    coordination,
    connection: {
      verifier: new TokenVerifier({ applications, coordination, startedAt, ...config.token }),
      devices: storage.devices,
      coordination,
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
  metrics.gauge('blindsignal_sessions', 'Sessions pending or active.', () =>
    [...server.sessionsByApplication().values()].reduce((sum, count) => sum + count, 0),
  );
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
    () => server.sessionsByApplication(),
  );
  const stopWatching = watchProcess(metrics);
  const port = await server.listen(config.port);
  const probe = dependencyProbe(dependencies, config.dependencyProbeTimeoutMs);
  const admin = await serveMetrics(
    { render: async () => metrics.render() + (await probe()) },
    config.adminPort,
    config.adminHost,
  );
  logger.log('info', 'server.listening', { port, adminPort: admin.port });

  const stopSweep = sweepDevices(
    storage.devices,
    { intervalMs: config.deviceSweepIntervalMs, ttlMs: config.deviceTtlMs },
    logger,
    metrics,
  );

  // All or nothing: a rejected reload keeps the current registry (ADR 0005).
  const reload = async () => {
    let next: RegistryResult;
    try {
      next = await readRegistry(registryPath, storage.applications, {
        now: new Date(),
        current: registry,
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
    // Other instances follow at once, or at their next sync when the event is lost (ADR 0024).
    await coordination
      .publish(REGISTRY_TOPIC, REGISTRY_CHANGED)
      .catch(() => logger.log('warn', 'registry.publish_failed'));
  };
  // Installs what another instance's reload stored; a failure keeps the current registry.
  const sync = async () => {
    try {
      registry = await syncRegistry(storage.applications, applications, registry);
    } catch {
      logger.log('warn', 'registry.sync_failed');
      return;
    }
    await server.enforce(registry.applications);
  };
  // One change at a time, so each is checked against the registry the previous one installed.
  let reloading = Promise.resolve();
  process.on('SIGHUP', () => {
    reloading = reloading.then(reload);
  });
  const stopFollowing =
    config.redis === undefined
      ? () => Promise.resolve()
      : await followRegistry(coordination, config.registrySyncIntervalMs, () => {
          reloading = reloading.then(sync);
        });

  const shutdown = async () => {
    logger.log('info', 'server.draining');
    await server.drain(config.shutdownDelayMs);
    await server.close();
    stopSweep();
    stopWatching();
    await stopFollowing();
    await closeCoordination();
    await closeStorage();
    admin.server.close();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      // A client or an adapter that never finishes must not outlast the platform's grace period.
      setTimeout(() => {
        logger.log('error', 'server.shutdown_timeout');
        process.exit(1);
      }, config.shutdownTimeoutMs).unref();
      void shutdown().finally(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  // Configuration and registry errors name keys, never values.
  const reason = error instanceof Error ? error.message : 'startup failed';
  logger.log('error', 'server.start_failed', { reason });
  process.exit(1);
});
