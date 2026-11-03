import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

/** Advisory lock keys of this adapter: `[LOCK_CLASS, LOCK_MIGRATIONS]`, `[LOCK_CLASS, hash]`. */
export const LOCK_CLASS = 0x42534947;
export const LOCK_MIGRATIONS = 0;

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
 * Applies the migrations the database lacks, each in its own transaction, under an advisory lock
 * so two runs never migrate together (ADR 0019). Returns the versions it applied.
 */
export async function migrate(pool: Pool, migrations?: readonly Migration[]): Promise<number[]> {
  const pending = migrations ?? (await loadMigrations());
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_CLASS, LOCK_MIGRATIONS]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version integer PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const { rows } = await client.query<{ version: number }>(
        'SELECT version FROM schema_migrations',
      );
      const applied = new Set(rows.map((row) => row.version));
      const done: number[] = [];
      for (const migration of pending) {
        if (applied.has(migration.version)) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
            migration.version,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        done.push(migration.version);
      }
      return done;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, LOCK_MIGRATIONS]);
    }
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
