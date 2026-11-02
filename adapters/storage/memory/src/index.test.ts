import type { ApplicationRecord } from '@blindsignal/core';
import { describe, expect, it } from 'vitest';
import { InMemoryApplicationRepository } from './index.ts';

const record = (appId: string, issuer: string): ApplicationRecord => ({
  appId,
  name: appId,
  status: 'active',
  issuer,
  audience: 'blindsignal',
  keys: { jwksUri: `${issuer}/jwks.json` },
  algorithms: ['EdDSA'],
  quotas: {},
  rateLimits: {},
  revokedDevices: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe('InMemoryApplicationRepository', () => {
  it('reads applications by id and by issuer', async () => {
    const repository = new InMemoryApplicationRepository();
    const notes = record('notes', 'https://notes.example');
    await repository.replaceAll([notes]);
    expect(await repository.getById('notes')).toBe(notes);
    expect(await repository.getByIssuer('https://notes.example')).toBe(notes);
    expect(await repository.getById('vault')).toBeUndefined();
  });

  it('replaces the whole registry', async () => {
    const repository = new InMemoryApplicationRepository();
    await repository.replaceAll([record('notes', 'https://notes.example')]);
    await repository.replaceAll([record('vault', 'https://vault.example')]);
    expect(await repository.getById('notes')).toBeUndefined();
    expect(await repository.getByIssuer('https://notes.example')).toBeUndefined();
    expect(await repository.getByIssuer('https://vault.example')).toBeDefined();
  });
});
