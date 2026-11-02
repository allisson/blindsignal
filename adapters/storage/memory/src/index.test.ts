import type { ApplicationRecord } from '@blindsignal/core';
import { describe, expect, it } from 'vitest';
import { InMemoryApplicationRepository, InMemoryDeviceRepository } from './index.ts';

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

describe('InMemoryDeviceRepository', () => {
  const at = (ms: number) => new Date(ms);
  const device = (userId: string, deviceId = 'd1', appId = 'notes') => ({
    appId,
    userId,
    deviceId,
  });
  const limits = { maxDevices: 2, ttlMs: 1000 };

  it('creates a record, then touches it', async () => {
    const repository = new InMemoryDeviceRepository();
    expect(await repository.touch(device('u1'), at(0), limits)).toEqual({
      ok: true,
      record: { ...device('u1'), firstSeenAt: at(0), lastAuthenticatedAt: at(0) },
    });
    expect(await repository.touch(device('u1'), at(500), limits)).toEqual({
      ok: true,
      record: { ...device('u1'), firstSeenAt: at(0), lastAuthenticatedAt: at(500) },
    });
  });

  it('refuses a new device over the quota, per application', async () => {
    const repository = new InMemoryDeviceRepository();
    await repository.touch(device('u1'), at(0), limits);
    await repository.touch(device('u1', 'd2'), at(0), limits);
    expect(await repository.touch(device('u2'), at(0), limits)).toEqual({
      ok: false,
      reason: 'quota_exceeded',
    });
    expect((await repository.touch(device('u1'), at(0), limits)).ok).toBe(true);
    expect((await repository.touch(device('u2', 'd1', 'vault'), at(0), limits)).ok).toBe(true);
  });

  it('expires records, which stop counting and re-enroll as new', async () => {
    const repository = new InMemoryDeviceRepository();
    await repository.touch(device('u1'), at(0), limits);
    await repository.touch(device('u2'), at(500), limits);
    expect((await repository.touch(device('u3'), at(1000), limits)).ok).toBe(true);
    expect(await repository.touch(device('u1'), at(1100), limits)).toEqual({
      ok: false,
      reason: 'quota_exceeded',
    });
    expect(await repository.touch(device('u1'), at(1600), limits)).toEqual({
      ok: true,
      record: { ...device('u1'), firstSeenAt: at(1600), lastAuthenticatedAt: at(1600) },
    });
  });
});
