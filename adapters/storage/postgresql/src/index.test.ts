import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeStorageContract } from '@blindsignal/core/testing';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  loadMigrations,
  migrate,
  openPostgreSQLStorage,
  PostgreSQLStorageAdapter,
  schemaVersion,
} from './index.ts';

// Runs only against a database: `docker compose --profile postgres up --wait postgres` (ADR 0019).
const url = process.env.BLINDSIGNAL_TEST_POSTGRES_URL;
const pools: pg.Pool[] = [];

async function createSchema(): Promise<string> {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  return schema;
}

/** A pool on a schema of its own, so tests never see each other's rows. */
async function isolated(): Promise<pg.Pool> {
  const schema = await createSchema();
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  pools.push(pool);
  return pool;
}

async function adapter(): Promise<PostgreSQLStorageAdapter> {
  const pool = await isolated();
  await migrate(pool);
  return new PostgreSQLStorageAdapter(pool);
}

afterAll(() => Promise.all(pools.map((pool) => pool.end())));

describe.skipIf(url === undefined)('PostgreSQL storage', () => {
  describeStorageContract('PostgreSQL storage', adapter);

  const device = (userId: string, deviceId = 'd1') => ({ appId: 'notes', userId, deviceId });
  const now = new Date(10_000);

  it('never exceeds the quota under concurrent first authentications', async () => {
    const { devices } = await adapter();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        devices.touch(device(`u${i}`), now, { maxDevices: 5, ttlMs: 1000 }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(5);
  });

  it('enrolls a device once when it authenticates concurrently', async () => {
    const pool = await isolated();
    await migrate(pool);
    const { devices } = new PostgreSQLStorageAdapter(pool);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        devices.touch(device('u1'), now, { maxDevices: 1, ttlMs: 1000 }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const { rows } = await pool.query('SELECT count(*)::integer AS count FROM devices');
    expect(rows).toEqual([{ count: 1 }]);
  });

  describe('openPostgreSQLStorage', () => {
    it('refuses a schema behind the migrations, then accepts it migrated', async () => {
      const schema = await createSchema();
      const options = encodeURIComponent(`-c search_path=${schema}`);
      const opened = openPostgreSQLStorage({
        url: `${url}?options=${options}`,
        poolSize: 2,
        onError: () => undefined,
      });
      try {
        const required = (await loadMigrations()).at(-1)?.version;
        await expect(opened.checkSchema()).rejects.toThrow(
          `the database schema is at version 0 and this release needs ${required}`,
        );
        const pool = new pg.Pool({ connectionString: `${url}?options=${options}`, max: 1 });
        pools.push(pool);
        await migrate(pool);
        await expect(opened.checkSchema()).resolves.toBeUndefined();
        await opened.storage.applications.replaceAll([]);
      } finally {
        await opened.end();
      }
    });

    it('reports the schema version', async () => {
      const pool = await isolated();
      expect(await schemaVersion(pool)).toBe(0);
      await migrate(pool, [{ version: 1, name: '0001_a.sql', sql: 'SELECT 1' }]);
      expect(await schemaVersion(pool)).toBe(1);
    });
  });

  describe('migrate', () => {
    it('applies each migration once, also when runs overlap', async () => {
      const pool = await isolated();
      const versions = (await loadMigrations()).map(({ version }) => version);
      const runs = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
      expect(runs.flat()).toEqual(versions);
      expect(await migrate(pool)).toEqual([]);
      const { rows } = await pool.query<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(rows.map(({ version }) => version)).toEqual(versions);
    });

    it('rolls a failed migration back and applies nothing after it', async () => {
      const pool = await isolated();
      const migrations = [
        { version: 1, name: '0001_ok.sql', sql: 'CREATE TABLE a (id integer)' },
        { version: 2, name: '0002_bad.sql', sql: 'CREATE TABLE b (id integer); SELECT nope' },
        { version: 3, name: '0003_after.sql', sql: 'CREATE TABLE c (id integer)' },
      ];
      await expect(migrate(pool, migrations)).rejects.toThrow('nope');
      const { rows } = await pool.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = current_schema() ORDER BY table_name`,
      );
      expect(rows.map(({ name }) => name)).toEqual(['a', 'schema_migrations']);
      // The lock was released: another run proceeds.
      expect(await migrate(pool, migrations.slice(0, 1))).toEqual([]);
    });
  });
});

describe('loadMigrations', () => {
  async function directory(names: string[]): Promise<URL> {
    const path = await mkdtemp(join(tmpdir(), 'migrations-'));
    await Promise.all(names.map((name) => writeFile(join(path, name), 'SELECT 1')));
    return pathToFileURL(`${path}/`);
  }

  it('loads the numbered files in order', async () => {
    const migrations = await loadMigrations(await directory(['0002_b.sql', '0001_a.sql', 'x.md']));
    expect(migrations.map(({ version, name }) => [version, name])).toEqual([
      [1, '0001_a.sql'],
      [2, '0002_b.sql'],
    ]);
  });

  it.each([['0001_a.sql', '0003_c.sql'], ['0001_a.sql', '0001_b.sql'], ['1_a.sql']])(
    'refuses a gap, a repeat, or a bad name: %s',
    async (...names) => {
      await expect(loadMigrations(await directory(names))).rejects.toThrow('out of sequence');
    },
  );

  it('ships a contiguous sequence', async () => {
    expect((await loadMigrations()).length).toBeGreaterThan(0);
  });
});
