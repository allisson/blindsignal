import { createBackend } from '@blindsignal/backend-issuer';
import { configFromEnv } from '@blindsignal/backend-issuer/config';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page and its backend share one origin, as the backend's SameSite=Strict cookie and Origin
// check expect.
const config = configFromEnv();
const port = Number(process.env.BLINDSIGNAL_EXAMPLE_PORT ?? 4000);
const serverUrl = process.env.BLINDSIGNAL_EXAMPLE_SIGNALING_URL ?? 'ws://localhost:8080';
const backend = createBackend(config);

const directory = (specifier: string) => dirname(fileURLToPath(import.meta.resolve(specifier)));

// shortcut: serves the SDK from source with the types stripped, as examples/browser-demo does; an
// application bundles it with its own build instead.
const roots: [string, string][] = [
  ['/sdk/', directory('@blindsignal/sdk')],
  ['/protocol/', directory('@blindsignal/protocol')],
  ['/zod/', directory('zod')],
  ['/', resolve(import.meta.dirname, 'public')],
];

const types: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  ts: 'text/javascript; charset=utf-8',
};

function locate(pathname: string): string | undefined {
  if (pathname === '/') return resolve(import.meta.dirname, 'public/index.html');
  const [prefix, root] = roots.find(([prefix]) => pathname.startsWith(prefix))!;
  const path = resolve(root, pathname.slice(prefix.length));
  return path.startsWith(root + sep) ? path : undefined;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'POST' || pathname.startsWith('/.well-known/')) {
    await backend(request, response);
    return;
  }
  if (pathname === '/config') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ serverUrl, appId: config.appId }));
    return;
  }
  const path = locate(pathname);
  const type = types[path?.split('.').pop() ?? ''];
  const text = path && type && (await readFile(path, 'utf8').catch(() => undefined));
  if (!text) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, { 'content-type': type })
    .end(path.endsWith('.ts') ? stripTypeScriptTypes(text) : text);
}

createServer((request, response) => {
  handle(request, response).catch(() => response.writeHead(500).end());
}).listen(port, '127.0.0.1', () => {
  console.log(`${config.appId} on http://127.0.0.1:${port}, signaling at ${serverUrl}`);
});
