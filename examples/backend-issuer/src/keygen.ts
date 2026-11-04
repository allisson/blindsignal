import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';

// Prints a new private signing key: keep it out of the repository and out of browser code.
const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const jwk = await exportJWK(privateKey);
console.log(JSON.stringify({ ...jwk, kid: await calculateJwkThumbprint(jwk) }));
