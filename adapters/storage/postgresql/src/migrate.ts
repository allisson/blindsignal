import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

/**
 * Advisory lock keys of this adapter: `[LOCK_CLASS, LOCK_MIGRATIONS]`, `[LOCK_CLASS, LOCK_REGISTRY]`,
 * `[LOCK_CLASS, hash]`.
 */
export const LOCK_CLASS = 0x42534947;
export const LOCK_MIGRATIONS = 0;
export const LOCK_REGISTRY = 1;

const directory = new URL('./migrations/', import.meta.url);

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** The numbered SQL files, in order; a missing or repeated number is an error. */
export async function loadMigrations(from: URL = directory): Promise<Migration[]> {
  const names = (await readdir(from)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name, index) => {
      const version = Number(/^(\d{4})_[a-z0-9_]+\.sql$/.exec(name)?.[1]);
      if (version !== index + 1) throw new Error(`migration ${name} is out of sequence`);
      return { version, name, sql: await readFile(new URL(name, from), 'utf8') };
    }),
  );
}

/**
 * Applies the migrations the database lacks, each in its own transaction, so two runs never
 * migrate together (ADR 0019). The lock is the transaction's, which a transaction-mode pooler
 * keeps on one server connection; a session's would not (ADR 0027). Returns the versions it applied.
 */
export async function migrate(pool: Pool, migrations?: readonly Migration[]): Promise<number[]> {
  const pending = migrations ?? (await loadMigrations());
  const client = await pool.connect();
  try {
    const done: number[] = [];
    for (const migration of pending) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_CLASS, LOCK_MIGRATIONS]);
        await client.query(
          `CREATE TABLE IF NOT EXISTS schema_migrations (
             version integer PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           )`,
        );
        // Read under the lock: another run may have applied it since this one started.
        const { rowCount } = await client.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [migration.version],
        );
        if (rowCount === 0) {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
            migration.version,
          ]);
          done.push(migration.version);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return done;
  } finally {
    client.release();
  }
}

/** The last migration applied, 0 when none ran. */
export async function schemaVersion(pool: Pool): Promise<number> {
  const table = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS exists",
  );
  if (table.rows[0]?.exists !== true) return 0;
  const { rows } = await pool.query<{ version: number }>(
    'SELECT coalesce(max(version), 0)::integer AS version FROM schema_migrations',
  );
  return rows[0]?.version ?? 0;
}
