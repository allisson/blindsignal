import { describe, expect, it } from 'vitest';
import { closeCodeFor, errorClasses, type ErrorCode } from './errors.ts';
import { appId, deviceId, namespaceId, requestId, sessionId } from './ids.ts';
import { messages, type MessageType } from './messages.ts';

describe('message catalog', () => {
  const types = Object.keys(messages) as MessageType[];

  it.each(types)('%s follows the naming rule', (type) => {
    expect(type).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/);
  });

  it.each(types)('%s has a reply only when client-sent, and the reply is server-sent', (type) => {
    const spec = messages[type];
    if (spec.direction === 'client') {
      const reply = (spec as { reply?: string }).reply as MessageType;
      expect(messages[reply].direction).toBe('server');
    } else {
      expect(spec).not.toHaveProperty('reply');
    }
  });
});

describe('error catalog', () => {
  it.each([
    ['invalid_message', 4001],
    ['quota_exceeded', 4001],
    ['malformed_frame', 4002],
    ['device_revoked', 4002],
    ['superseded', 4003],
    ['server_error', 4001],
  ] as [ErrorCode, number][])('%s closes with %i', (code, closeCode) => {
    expect(closeCodeFor(code)).toBe(closeCode);
  });

  it('classifies every code', () => {
    expect(Object.keys(errorClasses)).toHaveLength(19);
  });
});

describe('identifier formats', () => {
  it.each([
    [appId, 'chat', true],
    [appId, 'a'.repeat(64), true],
    [appId, 'a'.repeat(65), false],
    [appId, '-chat', false],
    [appId, 'Chat', false],
    [namespaceId, 'chat:room-1', true],
    [namespaceId, `chat:${'x'.repeat(128)}`, true],
    [namespaceId, `chat:${'x'.repeat(129)}`, false],
    [namespaceId, 'chat:', false],
    [namespaceId, 'chat:room 1', false],
    [namespaceId, 'chat:salão', false],
    [namespaceId, 'room-1', false],
    [deviceId, 'd'.repeat(256), true],
    [deviceId, 'd'.repeat(257), false],
    [deviceId, '', false],
    [sessionId, '0b6c1a52-6f0c-4c1e-9f3a-2d7e8c4b5a61', true],
    [sessionId, 'session-1', false],
    [requestId, 'r'.repeat(64), true],
    [requestId, 'r'.repeat(65), false],
  ] as const)('%#: %s → %s', (schema, value, valid) => {
    expect(schema.safeParse(value).success).toBe(valid);
  });
});
