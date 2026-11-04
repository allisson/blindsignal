import { readFile } from 'node:fs/promises';
import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import { openRedisCoordination } from '@blindsignal/coordination-redis';
import type { ApplicationRepository, CoordinationAdapter, StorageAdapter } from '@blindsignal/core';
import {
  InMemoryApplicationRepository,
  InMemoryDeviceRepository,
} from '@blindsignal/storage-memory';
import { openPostgreSQLStorage, SchemaVersionError } from '@blindsignal/storage-postgresql';
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
  OTLPExporter,
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

// Node's default for SIGHUP ends the process: until the reload is wired, one is only remembered.
let onReload: (() => void) | undefined;
let reloadMissed = false;
process.on('SIGHUP', () => {
  if (onReload === undefined) reloadMissed = true;
  else onReload();
});

/** A startup failure whose message names keys, never values, so it may be logged. */
class StartupError extends Error {}

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
  if (!loaded.ok) throw new StartupError(`invalid configuration: ${loaded.error}`);
  const config = loaded.config;
  logger = jsonLogger(undefined, undefined, config.logLevel);
  // A dependency that never answers, such as an unreachable Redis, must not hold the start.
  const startup = setTimeout(() => {
    logger.log('error', 'server.start_failed', { reason: 'startup timed out' });
    process.exit(1);
  }, config.startupTimeoutMs);
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
  if (!initial.ok) throw new StartupError(`invalid registry: ${initial.error}`);
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
  const metrics = new Metrics(
    config.otlp === undefined
      ? undefined
      : { exporter: new OTLPExporter(logger), intervalMs: config.otlp.intervalMs },
  );
  const server = new SignalingServer({
    allowedOrigins: config.allowedOrigins,
    proxyTrust: config.proxyTrust,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    closeTimeoutMs: config.closeTimeoutMs,
    maxConnectionMs: config.maxConnectionMs,
    maxConnections: config.maxConnections,
    preAuthentication: config.preAuthentication,
    coordination,
    connection: {
      verifier: new TokenVerifier({
        applications,
        coordination,
        startedAt,
        development: config.development,
        ...config.token,
      }),
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
  metrics.labeledGauge(
    'blindsignal_dependency_up',
    'Whether the dependency answered a probe within the timeout: 1 or 0.',
    'dependency',
    dependencyProbe(dependencies, config.dependencyProbeTimeoutMs),
  );
  const admin = await serveMetrics(metrics, config.adminPort, config.adminHost);

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
      registry = await syncRegistry(storage.applications, applications, registry, development);
    } catch {
      logger.log('warn', 'registry.sync_failed');
      return;
    }
    await server.enforce(registry.applications);
  };
  // One change at a time, so each is checked against the registry the previous one installed.
  let reloading = Promise.resolve();
  onReload = () => {
    reloading = reloading.then(reload);
  };
  if (reloadMissed) onReload();
  const stopFollowing =
    config.redis === undefined
      ? () => Promise.resolve()
      : await followRegistry(coordination, config.registrySyncIntervalMs, () => {
          reloading = reloading.then(sync);
        });

  const shutdown = async (deadline: number) => {
    logger.log('info', 'server.draining');
    await server.drain(config.shutdownDelayMs);
    await server.close();
    stopSweep();
    stopWatching();
    await stopFollowing();
    await closeCoordination();
    await closeStorage();
    admin.server.close();
    // The last push gets what is left of the deadline (ADR 0031), less a margin for the exit timer,
    // so an OTLP endpoint that never answers costs the push, not the exit status (ADR 0038).
    await metrics
      .shutdown(Math.max(deadline - Date.now() - 100, 0))
      .catch(() => logger.log('warn', 'telemetry.export_failed'));
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      const deadline = Date.now() + config.shutdownTimeoutMs;
      // A client or an adapter that never finishes must not outlast the platform's grace period.
      setTimeout(() => {
        logger.log('error', 'server.shutdown_timeout');
        process.exit(1);
      }, config.shutdownTimeoutMs).unref();
      void shutdown(deadline).finally(() => process.exit(0));
    });
  }
  // Only now: a SIGTERM before the handlers above would kill the process without draining it.
  clearTimeout(startup);
  logger.log('info', 'server.listening', { port, adminPort: admin.port });
}

main().catch((error: unknown) => {
  // Any other message may quote a value, such as a database user or host: only its name and code.
  const reason =
    error instanceof StartupError || error instanceof SchemaVersionError
      ? error.message
      : error instanceof Error
        ? error.name
        : 'startup failed';
  const code = (error as { code?: unknown } | undefined)?.code;
  logger.log('error', 'server.start_failed', {
    reason,
    code: typeof code === 'string' ? code : undefined,
  });
  process.exit(1);
});
