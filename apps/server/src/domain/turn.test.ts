import { describe, expect, it } from 'vitest';
import { turnServer } from './turn.ts';

const policy = {
  urls: ['turn:turn.example:3478', 'turns:turn.example:443?transport=tcp'],
  secret: '0123456789abcdef0123456789abcdef',
  credentialTtlSeconds: 900,
};
const NOW = new Date('2026-11-02T00:00:00.999Z');

describe('turnServer', () => {
  // Expected passwords computed apart, with Python's hmac module.
  it('mints <expiry>:<app_id> and its base64 HMAC-SHA1', () => {
    expect(turnServer(policy, 'notes', NOW)).toEqual({
      urls: policy.urls,
      username: '1793578500:notes',
      credential: 'Lxc4OCwln1z5YNY7jOmDviiIpwU=',
    });
  });

  it('expires the configured lifetime after now, in whole seconds', () => {
    const minted = turnServer({ ...policy, credentialTtlSeconds: 1000 }, 'notes', NOW);
    expect(minted.username).toBe('1793578600:notes');
    expect(minted.credential).toBe('rQg22C8gusOPcAH0uUT1NNgMFGU=');
  });

  it('scopes the credential to the application', () => {
    expect(turnServer(policy, 'chat', NOW)).toMatchObject({
      username: '1793578500:chat',
      credential: 'Ph/jTju2vgdeDEPZHFGWEB7QqCY=',
    });
  });
});
