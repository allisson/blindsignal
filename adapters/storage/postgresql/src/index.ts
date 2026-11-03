import type {
  ApplicationRecord,
  ApplicationRepository,
  DeviceIdentity,
  DeviceRepository,
  DeviceTouchResult,
  StorageAdapter,
} from '@blindsignal/core';
import pg, { type Pool, type PoolClient } from 'pg';
import { loadMigrations, LOCK_CLASS, schemaVersion } from './migrate.ts';

export { loadMigrations, migrate, schemaVersion, type Migration } from './migrate.ts';

export interface PostgreSQLStorage {
  readonly storage: PostgreSQLStorageAdapter;
  /** Rejects when the schema is behind this release's migrations (ADR 0019). */
  checkSchema(): Promise<void>;
  end(): Promise<void>;
}

/**
 * Opens a pool for the server. `onError` receives the errors of idle connections, which would
 * otherwise end the process.
 */
export function openPostgreSQLStorage(options: {
  readonly url: string;
  readonly poolSize: number;
  readonly onError: (error: Error) => void;
}): PostgreSQLStorage {
  const pool = new pg.Pool({ connectionString: options.url, max: options.poolSize });
  pool.on('error', options.onError);
  return {
    storage: new PostgreSQLStorageAdapter(pool),
    async checkSchema() {
      const [current, migrations] = await Promise.all([schemaVersion(pool), loadMigrations()]);
      const required = migrations.at(-1)?.version ?? 0;
      if (current < required) {
        throw new Error(
          `the database schema is at version ${current} and this release needs ${required}: run the migrate command`,
        );
      }
    },
    end: () => pool.end(),
  };
}

/** Durable storage on PostgreSQL (spec §10.1, ADR 0019); the schema comes from `migrate`. */
export class PostgreSQLStorageAdapter implements StorageAdapter {
  readonly applications: PostgreSQLApplicationRepository;
  readonly devices: PostgreSQLDeviceRepository;

  constructor(pool: Pool) {
    this.applications = new PostgreSQLApplicationRepository(pool);
    this.devices = new PostgreSQLDeviceRepository(pool);
  }
}

type StoredApplication = Omit<ApplicationRecord, 'createdAt' | 'updatedAt'> & {
  readonly createdAt: string;
  readonly updatedAt: string;
};

const hydrate = (record: StoredApplication): ApplicationRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

export class PostgreSQLApplicationRepository implements ApplicationRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  replaceAll(applications: readonly ApplicationRecord[]): Promise<void> {
    // One transaction: readers see the previous registry until it commits, never a partial one.
    return transaction(this.#pool, async (client) => {
      await client.query('DELETE FROM applications');
      await client.query(
        `INSERT INTO applications (app_id, issuer, record)
         SELECT a->>'appId', a->>'issuer', a FROM jsonb_array_elements($1::jsonb) AS a`,
        [JSON.stringify(applications)],
      );
    });
  }

  getById(appId: string): Promise<ApplicationRecord | undefined> {
    return this.#getBy('app_id', appId);
  }

  getByIssuer(issuer: string): Promise<ApplicationRecord | undefined> {
    return this.#getBy('issuer', issuer);
  }

  async getAll(): Promise<readonly ApplicationRecord[]> {
    const { rows } = await this.#pool.query<{ record: StoredApplication }>(
      'SELECT record FROM applications',
    );
    return rows.map((row) => hydrate(row.record));
  }

  async #getBy(column: 'app_id' | 'issuer', value: string) {
    const { rows } = await this.#pool.query<{ record: StoredApplication }>(
      `SELECT record FROM applications WHERE ${column} = $1`,
      [value],
    );
    return rows[0] === undefined ? undefined : hydrate(rows[0].record);
  }
}

interface DeviceRow {
  readonly first_seen_at: Date;
  readonly last_authenticated_at: Date;
}

const RENEW = `UPDATE devices SET last_authenticated_at = $4
  WHERE app_id = $1 AND user_id = $2 AND device_id = $3 AND last_authenticated_at > $5
  RETURNING first_seen_at, last_authenticated_at`;

export class PostgreSQLDeviceRepository implements DeviceRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async touch(
    device: DeviceIdentity,
    now: Date,
    { maxDevices, ttlMs }: { readonly maxDevices: number; readonly ttlMs: number },
  ): Promise<DeviceTouchResult> {
    const { appId, userId, deviceId } = device;
    const cutoff = new Date(now.getTime() - ttlMs);
    const ok = (row: DeviceRow): DeviceTouchResult => ({
      ok: true,
      record: {
        appId,
        userId,
        deviceId,
        firstSeenAt: row.first_seen_at,
        lastAuthenticatedAt: row.last_authenticated_at,
      },
    });
    const renew = [appId, userId, deviceId, now, cutoff];

    // A live device needs no lock: the quota counts only new ones.
    const live = await this.#pool.query<DeviceRow>(RENEW, renew);
    if (live.rows[0] !== undefined) return ok(live.rows[0]);

    // A new device: new devices of one application take turns, so concurrent first
    // authentications on any instance cannot exceed the quota (ADR 0010).
    return transaction(this.#pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_CLASS, appId]);
      await client.query('DELETE FROM devices WHERE app_id = $1 AND last_authenticated_at <= $2', [
        appId,
        cutoff,
      ]);
      // The same device may have enrolled while this call waited for the lock.
      const raced = await client.query<DeviceRow>(RENEW, renew);
      if (raced.rows[0] !== undefined) return ok(raced.rows[0]);
      const { rows } = await client.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM devices WHERE app_id = $1',
        [appId],
      );
      if ((rows[0]?.count ?? 0) >= maxDevices) return { ok: false, reason: 'quota_exceeded' };
      const inserted = await client.query<DeviceRow>(
        `INSERT INTO devices (app_id, user_id, device_id, first_seen_at, last_authenticated_at)
         VALUES ($1, $2, $3, $4, $4) RETURNING first_seen_at, last_authenticated_at`,
        [appId, userId, deviceId, now],
      );
      return ok(inserted.rows[0] as DeviceRow);
    });
  }

  async deleteExpired(now: Date, ttlMs: number): Promise<number> {
    const { rowCount } = await this.#pool.query(
      'DELETE FROM devices WHERE last_authenticated_at <= $1',
      [new Date(now.getTime() - ttlMs)],
    );
    return rowCount ?? 0;
  }
}
