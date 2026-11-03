import pg from 'pg';
import { migrate } from './migrate.ts';

// Run before each release, never on server startup (ADR 0019).
const connectionString = process.env.BLINDSIGNAL_DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('BLINDSIGNAL_DATABASE_URL is not set');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const applied = await migrate(pool);
  console.log(applied.length === 0 ? 'schema up to date' : `applied ${applied.join(', ')}`);
} catch (error) {
  // The URL may carry a password, so only the error's message is printed, never the URL.
  console.error(`migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
