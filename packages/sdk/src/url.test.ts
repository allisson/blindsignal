import { describe, expect, it } from 'vitest';
import { signalingUrl } from './url.ts';

describe('signalingUrl', () => {
  it.each([
    'wss://signal.example/',
    'wss://127.0.0.1:8443/',
    'ws://localhost:8080/',
    'ws://127.0.0.1:8080/',
    'ws://[::1]:8080/',
  ])('accepts %s', (serverUrl) => {
    expect(signalingUrl(serverUrl).href).toBe(serverUrl);
  });

  it.each([
    'ws://signal.example/',
    'ws://localhost.example/',
    'ws://127.0.0.2/',
    'ws://192.168.1.10:8080/',
    'https://signal.example/',
    'http://localhost:8080/',
  ])('refuses %s', (serverUrl) => {
    expect(() => signalingUrl(serverUrl)).toThrow(TypeError);
  });
});
