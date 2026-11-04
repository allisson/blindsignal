import { createServer } from 'node:http';
import { createBackend } from './backend.ts';
import { configFromEnv } from './config.ts';

const config = configFromEnv();
const port = Number(process.env.BLINDSIGNAL_EXAMPLE_PORT ?? 4000);
const handle = createBackend(config);

createServer((request, response) => void handle(request, response)).listen(port, '127.0.0.1', () =>
  console.log(`${config.appId} backend on http://127.0.0.1:${port}, issuer ${config.issuer}`),
);
