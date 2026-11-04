import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { calculateJwkThumbprint, EmbeddedJWK, importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import { z } from 'zod';

/** A private P-256 JWK with its `kid`: the backend's signing key, never sent anywhere. */
export const signingJwk = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
  d: z.string().min(1),
  kid: z.string().min(1),
});
export type SigningJwk = z.infer<typeof signingJwk>;

export interface BackendConfig {
  appId: string;
  /** The `iss` of every token, registered with BlindSignal. */
  issuer: string;
  audience: string;
  signingKey: SigningJwk;
  /** Origins whose pages may call the backend: every other request is refused (CSRF). */
  allowedOrigins: readonly string[];
  /** Requests a minute: to `/login` per client address, to the other routes per user. */
  rateLimitPerMinute: number;
}

const TOKEN_LIFETIME_S = 300;
/** The SDK signs approvals for 5 minutes; 60 seconds more absorb clock skew. */
const APPROVAL_MAX_LIFETIME_S = 360;
const APPROVAL_TYPE = 'blindsignal-pairing+jwt';
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_LIFETIME_S = 8 * 60 * 60;
const RATE_WINDOW_MS = 60_000;
// shortcut: fixed caps that bound the memory an example holds; a real backend keeps its state in a
// database and sizes these from its own load.
const MAX_SESSIONS = 10_000;
const MAX_USERS = 10_000;
const MAX_DEVICES_PER_USER = 10;

// Opaque IDs; a user ID is also the scope of the user's namespace, so it stays short and plain.
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
// A JWK thumbprint: base64url of a SHA-256 digest.
const thumbprint = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const bodies = {
  '/login': z.object({ user: id }),
  '/devices': z.object({ deviceId: id, jkt: thumbprint }),
  '/token': z.object({ deviceId: id }),
  '/pairings': z.object({ deviceId: id, namespace: z.string(), approval: z.string() }),
  '/logout': z.object({}),
};

interface Device {
  jkt: string;
  namespaces: Set<string>;
}

class HttpError extends Error {
  readonly status: number;
  readonly retryAfterS: number | undefined;

  constructor(status: number, retryAfterS?: number) {
    super(String(status));
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

/** The public half of the signing key, as the registry and the JWKS publish it. */
export function publicJwk({ kty, crv, x, y, kid }: SigningJwk) {
  return { kty, crv, x, y, kid, alg: 'ES256', use: 'sig' } as const;
}

/** This application's entry for the BlindSignal registry file (ADR 0005). */
export function registryEntry(
  config: Pick<BackendConfig, 'appId' | 'issuer' | 'audience' | 'signingKey'>,
) {
  return {
    appId: config.appId,
    name: config.appId,
    status: 'active',
    issuer: config.issuer,
    audience: config.audience,
    publicKeys: [publicJwk(config.signingKey)],
    algorithms: ['ES256'],
  };
}

/**
 * An application backend issuing BlindSignal tokens (docs/token-issuance.md). Each user's first
 * device gets the namespace `<appId>:<user>`; later devices only ask to be paired into it, until
 * one of the user's devices approves them (ADR 0042).
 *
 * shortcut: users, devices, sessions, and used pairing IDs live in memory, under fixed caps, and
 * vanish on restart; a real backend keeps them in its own database.
 */
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

/** WebKit drops a `Secure` cookie on plain-HTTP loopback, which Chromium and Firefox keep. */
function plainLoopback(origin: string): boolean {
  const { protocol, hostname } = new URL(origin);
  return protocol === 'http:' && loopback.has(hostname);
}

/**
 * The session cookie for an origin: `__Host-` keeps it to this host and path, which needs
 * `Secure`, so a plain-HTTP loopback page gets it unprefixed.
 */
function sessionCookie(origin: string) {
  const plain = plainLoopback(origin);
  const name = plain ? 'session' : '__Host-session';
  const attributes = `HttpOnly;${plain ? '' : ' Secure;'} SameSite=Strict; Path=/`;
  return {
    name,
    set: (value: string) => `${name}=${value}; Max-Age=${SESSION_LIFETIME_S}; ${attributes}`,
    clear: `${name}=; Max-Age=0; ${attributes}`,
  };
}

export function createBackend(config: BackendConfig) {
  const key = importJWK(config.signingKey, 'ES256');
  // In insertion order, so the first entry is the oldest session.
  const sessions = new Map<string, { user: string; expiresAt: number }>();
  const users = new Map<string, Map<string, Device>>();
  // Pairing ID → the `exp` of its approval: past it, the approval is refused anyway.
  const usedPairings = new Map<string, number>();
  const requests = new Map<string, number>();
  let windowStart = Date.now();
  const namespaceOf = (user: string) => `${config.appId}:${user}`;

  /** A fixed window: every key's count starts again each minute, so the map holds one minute. */
  function limit(key: string): void {
    const now = Date.now();
    if (now - windowStart >= RATE_WINDOW_MS) {
      requests.clear();
      windowStart = now;
    }
    const count = (requests.get(key) ?? 0) + 1;
    requests.set(key, count);
    if (count > config.rateLimitPerMinute) {
      throw new HttpError(429, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000));
    }
  }

  function device(user: string, deviceId: string): Device {
    const found = users.get(user)?.get(deviceId);
    if (found === undefined) throw new HttpError(404);
    return found;
  }

  async function token(user: string, deviceId: string): Promise<string> {
    const { jkt, namespaces } = device(user, deviceId);
    const iat = Math.floor(Date.now() / 1000);
    const granted = [...namespaces];
    return new SignJWT({
      app_id: config.appId,
      device_id: deviceId,
      namespaces: granted,
      // Not yet approved: the device may only ask its user's devices (ADR 0042).
      ...(granted.length === 0 && { pairing: [namespaceOf(user)] }),
      cnf: { jkt },
    })
      .setProtectedHeader({ alg: 'ES256', kid: config.signingKey.kid })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject(user)
      .setIssuedAt(iat)
      .setExpirationTime(iat + TOKEN_LIFETIME_S)
      .setJti(crypto.randomUUID())
      .sign(await key);
  }

  function enroll(user: string, deviceId: string, jkt: string): void {
    const devices = users.get(user) ?? new Map<string, Device>();
    const known = devices.get(deviceId);
    // The first key wins: a thumbprint the client could replace would let anyone holding the
    // user's session bind tokens to its own key.
    if (known !== undefined) {
      if (known.jkt !== jkt) throw new HttpError(409);
      return;
    }
    if (devices.size >= MAX_DEVICES_PER_USER) throw new HttpError(409);
    if (!users.has(user) && users.size >= MAX_USERS) throw new HttpError(503);
    const namespaces = new Set(devices.size === 0 ? [namespaceOf(user)] : []);
    devices.set(deviceId, { jkt, namespaces });
    users.set(user, devices);
  }

  /** Grants the namespace after the checks of docs/token-issuance.md, Pairing. */
  async function pair(user: string, deviceId: string, namespace: string, approval: string) {
    const target = device(user, deviceId);
    const verified = await jwtVerify(approval, EmbeddedJWK, {
      typ: APPROVAL_TYPE,
      algorithms: ['ES256', 'EdDSA'],
      requiredClaims: ['exp'],
    }).catch(() => undefined);
    if (verified === undefined) throw new HttpError(403);
    const { payload, protectedHeader } = verified;
    const signer = await calculateJwkThumbprint(protectedHeader.jwk as JWK, 'sha256');
    const approver = [...(users.get(user)?.values() ?? [])].find(
      (candidate) => candidate.jkt === signer,
    );
    const pairingId = payload.pairing_id;
    const valid =
      // Only a device holding the namespace approves: never the new device itself.
      approver?.namespaces.has(namespace) === true &&
      payload.namespace === namespace &&
      payload.sub === user &&
      payload.device_id === deviceId &&
      payload.jkt === target.jkt &&
      payload.exp! <= Date.now() / 1000 + APPROVAL_MAX_LIFETIME_S &&
      typeof pairingId === 'string' &&
      !usedPairings.has(pairingId);
    if (!valid) throw new HttpError(403);
    const now = Date.now() / 1000;
    for (const [used, exp] of usedPairings) if (exp < now) usedPairings.delete(used);
    usedPairings.set(pairingId, payload.exp!);
    target.namespaces.add(namespace);
  }

  /** The session the request's cookie names, while it lasts. */
  function sessionOf(request: IncomingMessage): string | undefined {
    const { name } = sessionCookie(request.headers.origin!);
    return request.headers.cookie
      ?.split(';')
      .map((pair) => pair.trim().split('='))
      .find(([key]) => key === name)?.[1];
  }

  function sessionUser(request: IncomingMessage): string {
    const session = sessionOf(request);
    const found = session === undefined ? undefined : sessions.get(session);
    if (found === undefined || found.expiresAt <= Date.now()) {
      if (session !== undefined) sessions.delete(session);
      throw new HttpError(401);
    }
    return found.user;
  }

  async function readBody(request: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400);
    }
  }

  async function post(
    path: keyof typeof bodies,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    // A cross-site form can send neither an allowed Origin nor a JSON content type.
    if (!config.allowedOrigins.includes(request.headers.origin ?? '')) throw new HttpError(403);
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      throw new HttpError(415);
    }
    const parsed = bodies[path].safeParse(await readBody(request));
    if (!parsed.success) throw new HttpError(400);
    const body = parsed.data as Record<string, string>;
    const cookie = sessionCookie(request.headers.origin!);
    if (path === '/login') {
      limit(`address:${request.socket.remoteAddress}`);
      // Stands in for the application's own sign-in: there is no password.
      const session = randomBytes(32).toString('base64url');
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      sessions.set(session, {
        user: body.user!,
        expiresAt: Date.now() + SESSION_LIFETIME_S * 1000,
      });
      response.writeHead(204, { 'set-cookie': cookie.set(session) }).end();
      return;
    }
    if (path === '/logout') {
      const session = sessionOf(request);
      if (session !== undefined) sessions.delete(session);
      response.writeHead(204, { 'set-cookie': cookie.clear }).end();
      return;
    }
    const user = sessionUser(request);
    limit(`user:${user}`);
    if (path === '/devices') enroll(user, body.deviceId!, body.jkt!);
    if (path === '/pairings') await pair(user, body.deviceId!, body.namespace!, body.approval!);
    if (path === '/token') {
      const issued = await token(user, body.deviceId!);
      response
        .writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        .end(issued);
      return;
    }
    response.writeHead(204).end();
  }

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const { pathname } = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && pathname === '/.well-known/jwks.json') {
        response
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' })
          .end(JSON.stringify({ keys: [publicJwk(config.signingKey)] }));
        return;
      }
      if (request.method !== 'POST' || !Object.hasOwn(bodies, pathname)) throw new HttpError(404);
      await post(pathname as keyof typeof bodies, request, response);
    } catch (error) {
      // Status codes only: the client learns nothing about which check failed.
      if (error instanceof HttpError) {
        const retryAfter = error.retryAfterS;
        response.writeHead(
          error.status,
          retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
        );
      } else {
        response.writeHead(500);
      }
      response.end();
    }
  };
}
