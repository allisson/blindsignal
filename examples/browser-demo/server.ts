import { mintDevToken } from '@blindsignal/dev-issuer';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The token endpoint signs with the dev key, whose private half is public in this repository.
if (process.env.BLINDSIGNAL_ENV !== 'development') {
  throw new Error('the demo mints development tokens: set BLINDSIGNAL_ENV=development');
}

const port = Number(process.env.BLINDSIGNAL_DEMO_PORT ?? 3000);
const serverUrl = process.env.BLINDSIGNAL_DEMO_SIGNALING_URL ?? 'ws://localhost:8080';

const directory = (specifier: string) => dirname(fileURLToPath(import.meta.resolve(specifier)));

// URL prefix → directory. The browser loads the SDK from source, with no bundler: TypeScript is
// stripped on the way out, and the page's import map resolves the bare specifiers.
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
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/config') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ serverUrl }));
    return;
  }
  // Stands in for the application backend, which issues tokens to its own signed-in users.
  if (url.pathname === '/token') {
    const sub = url.searchParams.get('user');
    const device_id = url.searchParams.get('device');
    const jkt = url.searchParams.get('jkt');
    // A new device may only ask to be paired into the namespace (ADR 0042).
    const pairing = url.searchParams.has('pairing');
    // Each application of the registry has a `demo` namespace; `notes` by default.
    const app_id = url.searchParams.get('app') ?? 'notes';
    const namespace = `${app_id}:demo`;
    if (!sub || !device_id) {
      response.writeHead(400).end();
      return;
    }
    const token = await mintDevToken({
      app_id,
      sub,
      device_id,
      ...(pairing ? { pairing: [namespace] } : { namespaces: [namespace] }),
      ...(jkt && { cnf: { jkt } }),
    });
    response
      .writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      .end(token);
    return;
  }
  const path = locate(url.pathname);
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
  console.log(`BlindSignal demo on http://127.0.0.1:${port}, signaling at ${serverUrl}`);
});
