import { describe, expect, it } from 'vitest';
import { turnServer } from './turn.ts';

const policy = {
  urls: ['turn:turn.example:3478', 'turns:turn.example:443?transport=tcp'],
  secret: '0123456789abcdef0123456789abcdef',
  credentialTtlSeconds: 900,
};
const NOW = new Date('2026-11-02T00:00:00.999Z');
const NONCE = 'q1w2e3r4t5y6u7i8';

describe('turnServer', () => {
  // Expected passwords computed apart, with Python's hmac module.
  it('mints <expiry>:<app_id>:<nonce> and its base64 HMAC-SHA1', () => {
    expect(turnServer(policy, 'notes', NOW, NONCE)).toEqual({
      urls: policy.urls,
      username: '1793578500:notes:q1w2e3r4t5y6u7i8',
      credential: 'BlmlrD6RORYJcpgr3t8IEBCE1oQ=',
    });
  });

  it('expires the configured lifetime after now, in whole seconds', () => {
    const minted = turnServer({ ...policy, credentialTtlSeconds: 1000 }, 'notes', NOW, NONCE);
    expect(minted.username).toBe('1793578600:notes:q1w2e3r4t5y6u7i8');
    expect(minted.credential).toBe('Xx9ze0qCP5pfNDwKc31kyGVq2u8=');
  });

  it('scopes the credential to the application', () => {
    expect(turnServer(policy, 'chat', NOW, NONCE)).toMatchObject({
      username: '1793578500:chat:q1w2e3r4t5y6u7i8',
      credential: '46k7XDIPiQSNW+FBXkzCDmceY90=',
    });
  });

  it('mints a distinct user for each credential of one second', () => {
    const first = turnServer(policy, 'notes', NOW);
    const second = turnServer(policy, 'notes', NOW);
    // 12 random bytes in base64url: no `:`, which Coturn reads as the separator.
    expect(first.username).toMatch(/^1793578500:notes:[\w-]{16}$/);
    expect(second.username).toMatch(/^1793578500:notes:[\w-]{16}$/);
    expect(second.username).not.toBe(first.username);
    expect(second.credential).not.toBe(first.credential);
  });
});
