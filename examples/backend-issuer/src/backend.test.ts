import { DeviceKey } from '@blindsignal/sdk';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBackend, registryEntry, type SigningJwk } from './backend.ts';
import { configFromEnv } from './config.ts';

const ORIGIN = 'http://app.test';
const signingKey = await (async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return { ...(await exportJWK(privateKey)), kid: 'test' } as SigningJwk;
})();
const config = {
  appId: 'example',
  issuer: 'https://api.example.test',
  audience: 'blindsignal',
  signingKey,
  allowedOrigins: [
    ORIGIN,
    'http://127.0.0.1:3797',
    'http://localhost:3797',
    'http://[::1]:3797',
    'https://localhost:3797',
  ],
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

let handle: ReturnType<typeof createBackend>;
beforeEach(() => {
  handle = createBackend(config);
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function login(user: string): Promise<string> {
  const response = await post('/login', { user });
  expect(response.status).toBe(204);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

/** A device: a non-extractable key pair, its SDK `DeviceKey`, and its public JWK. */
async function newDevice() {
  const pair = await generateKeyPair('ES256');
  return { pair, key: await DeviceKey.from(pair), jwk: await exportJWK(pair.publicKey) };
}
type Device = Awaited<ReturnType<typeof newDevice>>;

async function enroll(cookie: string, deviceId: string, device: Device) {
  return post('/devices', { deviceId, jkt: device.key.thumbprint }, { cookie });
}

async function claims(cookie: string, deviceId: string) {
  const response = await post('/token', { deviceId }, { cookie });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const jwks = (await (await fetch(`${base}/.well-known/jwks.json`)).json()) as never;
  const { payload } = await jwtVerify(await response.text(), createLocalJWKSet(jwks), {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ['ES256'],
  });
  return payload;
}

describe('backend issuer', () => {
  it('publishes only the public half of its key', async () => {
    const response = await fetch(`${base}/.well-known/jwks.json`);
    const { keys } = (await response.json()) as { keys: Record<string, string>[] };
    expect(keys).toEqual([{ ...registryEntry(config).publicKeys[0] }]);
    expect(keys[0]).not.toHaveProperty('d');
    expect(registryEntry(config)).toMatchObject({
      appId: 'example',
      issuer: config.issuer,
      algorithms: ['ES256'],
    });
  });

  it("grants a user's first device the user's namespace, bound to its key", async () => {
    const cookie = await login('alice');
    const laptop = await newDevice();
    expect((await enroll(cookie, 'laptop', laptop)).status).toBe(204);
    const token = await claims(cookie, 'laptop');
    expect(token).toMatchObject({
      sub: 'alice',
      app_id: 'example',
      device_id: 'laptop',
      namespaces: ['example:alice'],
      cnf: { jkt: laptop.key.thumbprint },
    });
    expect(token).not.toHaveProperty('pairing');
    expect(token.exp! - token.iat!).toBe(300);
    expect(token.jti).not.toBe((await claims(cookie, 'laptop')).jti);
  });

  it('keeps the first key of a device', async () => {
    const cookie = await login('alice');
    const laptop = await newDevice();
    await enroll(cookie, 'laptop', laptop);
    expect((await enroll(cookie, 'laptop', laptop)).status).toBe(204);
    expect((await enroll(cookie, 'laptop', await newDevice())).status).toBe(409);
    expect((await claims(cookie, 'laptop')).cnf).toEqual({ jkt: laptop.key.thumbprint });
  });

  describe('pairing', () => {
    let cookie: string;
    let laptop: Device;
    let tablet: Device;
    const request = () => ({
      pairingId: crypto.randomUUID(),
      namespace: 'example:alice',
      userId: 'alice',
      deviceId: 'tablet',
      jkt: tablet.key.thumbprint,
    });
    const pair = (approval: string, namespace = 'example:alice', deviceId = 'tablet') =>
      post('/pairings', { deviceId, namespace, approval }, { cookie });

    /** An approval with any header and claims, signed by `device`. */
    async function sign(device: Device, overrides: Record<string, unknown>, typ?: string) {
      const exp = Math.floor(Date.now() / 1000) + 300;
      const { pairingId, namespace, userId, deviceId, jkt } = request();
      return new SignJWT({
        pairing_id: pairingId,
        namespace,
        sub: userId,
        device_id: deviceId,
        jkt,
        exp,
        ...overrides,
      })
        .setProtectedHeader({
          alg: 'ES256',
          typ: typ ?? 'blindsignal-pairing+jwt',
          jwk: device.jwk,
        })
        .sign(device.pair.privateKey);
    }

    beforeEach(async () => {
      cookie = await login('alice');
      laptop = await newDevice();
      tablet = await newDevice();
      await enroll(cookie, 'laptop', laptop);
      await enroll(cookie, 'tablet', tablet);
    });

    it('lets a later device only ask to be paired', async () => {
      const token = await claims(cookie, 'tablet');
      expect(token).toMatchObject({ namespaces: [], pairing: ['example:alice'] });
    });

    it("grants the namespace on an approval signed by the user's device, once", async () => {
      const approval = await laptop.key.approval(request());
      expect((await pair(approval)).status).toBe(204);
      const token = await claims(cookie, 'tablet');
      expect(token).toMatchObject({ namespaces: ['example:alice'] });
      expect(token).not.toHaveProperty('pairing');
      expect((await pair(approval)).status).toBe(403);
    });

    it.each<[string, () => Promise<string>, string?]>([
      ['signed by the new device itself', () => sign(tablet, {})],
      ['signed by an unknown key', async () => sign(await newDevice(), {})],
      ['of another type', () => sign(laptop, {}, 'blindsignal-pop+jwt')],
      ['for another namespace', () => sign(laptop, { namespace: 'example:bob' })],
      ['asked for another namespace', () => sign(laptop, {}), 'example:bob'],
      ['for another user', () => sign(laptop, { sub: 'bob' })],
      ['for another device', () => sign(laptop, { device_id: 'phone' })],
      ['for another key', () => sign(laptop, { jkt: laptop.key.thumbprint })],
      ['without a pairing ID', () => sign(laptop, { pairing_id: undefined })],
      ['expired', () => sign(laptop, { exp: Math.floor(Date.now() / 1000) - 1 })],
      ['valid too long', () => sign(laptop, { exp: Math.floor(Date.now() / 1000) + 600 })],
      ['malformed', () => Promise.resolve('not-a-jwt')],
    ])('refuses an approval %s', async (_, approval, namespace) => {
      expect((await pair(await approval(), namespace)).status).toBe(403);
      expect(await claims(cookie, 'tablet')).toMatchObject({ namespaces: [] });
    });

    it('refuses an approval from a device that was never granted the namespace', async () => {
      const phone = await newDevice();
      await enroll(cookie, 'phone', phone);
      expect((await pair(await phone.key.approval(request()))).status).toBe(403);
    });

    it("refuses an approval from another user's device", async () => {
      const bob = await login('bob');
      const phone = await newDevice();
      await enroll(bob, 'phone', phone);
      expect((await pair(await phone.key.approval(request()))).status).toBe(403);
    });

    it('refuses an approval for a device the user never enrolled', async () => {
      const approval = await laptop.key.approval({ ...request(), deviceId: 'phone' });
      expect((await pair(approval, 'example:alice', 'phone')).status).toBe(404);
    });
  });

  describe('requests', () => {
    it.each<[string, () => Promise<Response>, number]>([
      ['without a session', () => post('/token', { deviceId: 'laptop' }), 401],
      [
        'with an unknown session',
        () => post('/token', { deviceId: 'laptop' }, { cookie: 'session=x' }),
        401,
      ],
      [
        'from another origin',
        () => post('/login', { user: 'alice' }, { origin: 'https://evil.test' }),
        403,
      ],
      ['without an origin', () => post('/login', { user: 'alice' }, { origin: '' }), 403],
      ['as a form', () => post('/login', { user: 'alice' }, { 'content-type': 'text/plain' }), 415],
      ['with invalid JSON', () => post('/login', '{'), 400],
      ['with an invalid body', () => post('/login', { user: 'a b' }), 400],
      ['too large', () => post('/login', { user: 'x'.repeat(20_000) }), 413],
      ['to an unknown route', () => post('/admin', {}), 404],
      ['with GET to a POST route', () => fetch(`${base}/token`), 404],
    ])('refuses a request %s', async (_, send, status) => {
      expect((await send()).status).toBe(status);
    });

    it('refuses a token for a device not enrolled', async () => {
      const cookie = await login('alice');
      expect((await post('/token', { deviceId: 'laptop' }, { cookie })).status).toBe(404);
    });

    it('sets a session cookie scripts cannot read', async () => {
      const response = await post('/login', { user: 'alice' });
      expect(response.headers.get('set-cookie')).toMatch(
        /^session=[\w-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/$/,
      );
    });

    it('leaves Secure out only for a plain-HTTP loopback origin', async () => {
      const cookie = async (origin: string) =>
        (await post('/login', { user: 'alice' }, { origin })).headers.get('set-cookie');
      for (const origin of [
        'http://127.0.0.1:3797',
        'http://localhost:3797',
        'http://[::1]:3797',
      ]) {
        expect(await cookie(origin)).toMatch(
          /^session=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/$/,
        );
      }
      expect(await cookie('https://localhost:3797')).toContain('; Secure;');
    });
  });
});

describe('configFromEnv', () => {
  it('requires the signing key', () => {
    expect(() => configFromEnv({})).toThrow(/BLINDSIGNAL_EXAMPLE_SIGNING_JWK/);
  });

  it('defaults to the local port, and splits the allowed origins', () => {
    const key = JSON.stringify(signingKey);
    expect(configFromEnv({ BLINDSIGNAL_EXAMPLE_SIGNING_JWK: key })).toMatchObject({
      appId: 'example',
      issuer: 'http://127.0.0.1:4000',
      allowedOrigins: ['http://127.0.0.1:4000'],
    });
    const env = {
      BLINDSIGNAL_EXAMPLE_SIGNING_JWK: key,
      BLINDSIGNAL_EXAMPLE_ALLOWED_ORIGINS: 'https://a.test, https://b.test',
    };
    expect(configFromEnv(env).allowedOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  it('refuses a key without its private half', () => {
    // JSON leaves out the undefined private half.
    const env = {
      BLINDSIGNAL_EXAMPLE_SIGNING_JWK: JSON.stringify({ ...signingKey, d: undefined }),
    };
    expect(() => configFromEnv(env)).toThrow();
  });
});
