import { signingJwk, type BackendConfig } from './backend.ts';

/** The backend's configuration, from the environment; see README.md. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const raw = env.BLINDSIGNAL_EXAMPLE_SIGNING_JWK;
  if (!raw) {
    throw new Error('set BLINDSIGNAL_EXAMPLE_SIGNING_JWK to the output of the keygen script');
  }
  const port = env.BLINDSIGNAL_EXAMPLE_PORT ?? '4000';
  return {
    appId: env.BLINDSIGNAL_EXAMPLE_APP_ID ?? 'example',
    issuer: env.BLINDSIGNAL_EXAMPLE_ISSUER ?? `http://127.0.0.1:${port}`,
    audience: 'blindsignal',
    signingKey: signingJwk.parse(JSON.parse(raw)),
    allowedOrigins: (env.BLINDSIGNAL_EXAMPLE_ALLOWED_ORIGINS ?? `http://127.0.0.1:${port}`)
      .split(',')
      .map((origin) => origin.trim()),
  };
}
