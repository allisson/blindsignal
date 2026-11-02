import { readFile } from 'node:fs/promises';
import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import {
  InMemoryApplicationRepository,
  InMemoryDeviceRepository,
} from '@blindsignal/storage-memory';
import { loadConfig } from './config.ts';
import { TokenVerifier } from './domain/auth.ts';
import { parseRegistry } from './domain/registry.ts';
import { SessionRegistry } from './domain/sessions.ts';
import { SignalingServer } from './server.ts';

/** Wires the adapters and starts the server; the only module that imports adapters (ADR 0002). */
async function main(): Promise<void> {
  const loaded = loadConfig(process.env);
  if (!loaded.ok) throw new Error(`invalid configuration: ${loaded.error}`);
  const config = loaded.config;
  const startedAt = new Date();

  let text: string;
  try {
    text = await readFile(config.registryPath, 'utf8');
  } catch {
    // The path is operator configuration, not a secret; the error's message could quote more.
    throw new Error(`cannot read the registry at ${config.registryPath}`);
  }
  const registry = parseRegistry(text, { now: startedAt, development: config.development });
  if (!registry.ok) throw new Error(`invalid registry: ${registry.error}`);

  const applications = new InMemoryApplicationRepository();
  await applications.replaceAll(registry.registry.applications);
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
