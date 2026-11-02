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
  const server = new SignalingServer({
    allowedOrigins: config.allowedOrigins,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    connection: {
      verifier: new TokenVerifier({ applications, coordination, startedAt, ...config.token }),
      devices: new InMemoryDeviceRepository(),
      coordination,
      sessions: new SessionRegistry(),
      iceServers: config.iceServers.map(({ urls }) => ({ urls: [...urls] })),
      clockSkewSeconds: config.token.clockSkewSeconds,
      deviceLimits: config.devices,
      presenceLeaseMs: config.presenceLeaseMs,
      negotiationTimeoutMs: config.negotiationTimeoutMs,
    },
  });
  await server.listen(config.port);

  // All or nothing: a rejected reload keeps the current registry (ADR 0005).
  const reload = async () => {
    const next = await readRegistry(registryPath, {
      now: new Date(),
      previous: registry,
      development,
    });
    if (!next.ok) {
      console.error(`registry reload rejected: ${next.error}`);
      return;
    }
    registry = next.registry;
    await applications.replaceAll(registry.applications);
    await server.enforce(registry.applications);
    console.error('registry reloaded');
  };
  // One reload at a time, so each is checked against the registry the previous one installed.
  let reloading = Promise.resolve();
  process.on('SIGHUP', () => {
    reloading = reloading.then(reload);
  });

  const shutdown = async () => {
    await server.drain();
    await server.close();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown().finally(() => process.exit(0)));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'startup failed');
  process.exit(1);
});
