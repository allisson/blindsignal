import { describe, expect, it } from 'vitest';
import type { ApplicationRecord } from '../records.ts';
import type { StorageAdapter } from '../storage.ts';

const application = (appId: string, issuer: string): ApplicationRecord => ({
  appId,
  name: appId,
  status: 'active',
  issuer,
  audience: 'blindsignal',
  keys: { publicKeys: [{ kid: 'k1', kty: 'OKP', crv: 'Ed25519', x: 'AAAA' }] },
  algorithms: ['EdDSA'],
  quotas: { devices: 10 },
  rateLimits: { discovery: { ratePerSecond: 1, burst: 5 } },
  revokedDevices: [{ userId: 'u9', deviceId: 'd9' }],
  createdAt: new Date(1_000),
  updatedAt: new Date(2_000),
});

const at = (ms: number) => new Date(ms);
const device = (userId: string, deviceId = 'd1', appId = 'notes') => ({ appId, userId, deviceId });
const limits = { maxDevices: 2, ttlMs: 1000 };

/**
 * The behavior every `StorageAdapter` shares (ADR 0010, ADR 0019). `create` returns an empty
 * adapter for each test.
 */
export function describeStorageContract(name: string, create: () => Promise<StorageAdapter>) {
  describe(`${name}: applications`, () => {
    it('reads applications by id and by issuer', async () => {
      const { applications } = await create();
      const notes = application('notes', 'https://notes.example');
      await applications.replaceAll([notes]);
      expect(await applications.getById('notes')).toEqual(notes);
      expect(await applications.getByIssuer('https://notes.example')).toEqual(notes);
      expect(await applications.getById('vault')).toBeUndefined();
      expect(await applications.getByIssuer('https://vault.example')).toBeUndefined();
    });

    it('lists every application', async () => {
      const { applications } = await create();
      expect(await applications.getAll()).toEqual([]);
      const notes = application('notes', 'https://notes.example');
      const vault = application('vault', 'https://vault.example');
      await applications.replaceAll([notes, vault]);
      const all = [...(await applications.getAll())].sort((a, b) => a.appId.localeCompare(b.appId));
      expect(all).toEqual([notes, vault]);
    });

    it('replaces the whole registry', async () => {
      const { applications } = await create();
      await applications.replaceAll([application('notes', 'https://notes.example')]);
      await applications.replaceAll([application('vault', 'https://vault.example')]);
      expect(await applications.getById('notes')).toBeUndefined();
      expect(await applications.getByIssuer('https://notes.example')).toBeUndefined();
      expect(await applications.getByIssuer('https://vault.example')).toBeDefined();
      await applications.replaceAll([]);
      expect(await applications.getById('vault')).toBeUndefined();
      expect(await applications.getAll()).toEqual([]);
    });
  });

  describe(`${name}: devices`, () => {
    it('creates a record, then touches it', async () => {
      const { devices } = await create();
      expect(await devices.touch(device('u1'), at(0), limits)).toEqual({
        ok: true,
        record: { ...device('u1'), firstSeenAt: at(0), lastAuthenticatedAt: at(0) },
      });
      expect(await devices.touch(device('u1'), at(500), limits)).toEqual({
        ok: true,
        record: { ...device('u1'), firstSeenAt: at(0), lastAuthenticatedAt: at(500) },
      });
    });

    it('refuses a new device over the quota, per application', async () => {
      const { devices } = await create();
      await devices.touch(device('u1'), at(0), limits);
      await devices.touch(device('u1', 'd2'), at(0), limits);
      expect(await devices.touch(device('u2'), at(0), limits)).toEqual({
        ok: false,
        reason: 'quota_exceeded',
      });
      expect((await devices.touch(device('u1'), at(0), limits)).ok).toBe(true);
      expect((await devices.touch(device('u2', 'd1', 'vault'), at(0), limits)).ok).toBe(true);
    });

    it('expires records, which stop counting and re-enroll as new', async () => {
      const { devices } = await create();
      await devices.touch(device('u1'), at(0), limits);
      await devices.touch(device('u2'), at(500), limits);
      expect((await devices.touch(device('u3'), at(1000), limits)).ok).toBe(true);
      expect(await devices.touch(device('u1'), at(1100), limits)).toEqual({
        ok: false,
        reason: 'quota_exceeded',
      });
      expect(await devices.touch(device('u1'), at(1600), limits)).toEqual({
        ok: true,
        record: { ...device('u1'), firstSeenAt: at(1600), lastAuthenticatedAt: at(1600) },
      });
    });

    it('treats a record exactly one TTL old as expired', async () => {
      const { devices } = await create();
      await devices.touch(device('u1'), at(0), limits);
      expect(await devices.touch(device('u1'), at(1000), limits)).toEqual({
        ok: true,
        record: { ...device('u1'), firstSeenAt: at(1000), lastAuthenticatedAt: at(1000) },
      });
    });

    it('deletes expired records across applications', async () => {
      const { devices } = await create();
      await devices.touch(device('u1'), at(0), limits);
      await devices.touch(device('u2', 'd1', 'vault'), at(0), limits);
      await devices.touch(device('u3'), at(500), limits);
      expect(await devices.deleteExpired(at(999), 1000)).toBe(0);
      expect(await devices.deleteExpired(at(1000), 1000)).toBe(2);
      expect(await devices.deleteExpired(at(1000), 1000)).toBe(0);
      // u1 is gone, so it enrolls again; u3 is still live and keeps its first authentication.
      expect(await devices.touch(device('u1'), at(1000), limits)).toEqual({
        ok: true,
        record: { ...device('u1'), firstSeenAt: at(1000), lastAuthenticatedAt: at(1000) },
      });
      expect(await devices.touch(device('u3'), at(1000), limits)).toEqual({
        ok: true,
        record: { ...device('u3'), firstSeenAt: at(500), lastAuthenticatedAt: at(1000) },
      });
    });
  });
}
