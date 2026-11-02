import { describe, expect, it } from 'vitest';
import { isOriginAllowed } from './origin.ts';

describe('isOriginAllowed', () => {
  const allowed = new Set(['https://app.example', 'http://localhost:5173']);

  it('allows a listed origin', () => {
    expect(isOriginAllowed('https://app.example', allowed)).toBe(true);
  });

  it.each(['https://evil.example', 'http://app.example', 'https://app.example:8443', 'null'])(
    'rejects %s',
    (origin) => {
      expect(isOriginAllowed(origin, allowed)).toBe(false);
    },
  );

  it('allows a request without Origin, which only non-browser clients send', () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
  });

  it('allows every origin with *', () => {
    expect(isOriginAllowed('https://evil.example', '*')).toBe(true);
  });
});
