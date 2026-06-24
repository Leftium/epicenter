/**
 * Cloudflare backend for the db concern: a per-request `pg.Client` over the
 * Hyperdrive connection string.
 *
 * Mirrors {@link createDurableObjectRooms}: a deployment passes the
 * `HYPERDRIVE` binding from its `c.env` and gets back the runtime-neutral
 * `{ db, close }` handle that `createServerApp`'s `connectDb` concern
 * expects. Both Cloudflare deployables (`apps/api`, `apps/self-host`) call
 * this, so the per-request acquisition lives here once instead of being
 * restated at each edge. A Node host injects its own `connectDb` over a
 * module-scope `pg.Pool` instead.
 *
 * Uses `Client` (not `Pool`) because Hyperdrive IS the connection pool.
 */

import pg from 'pg';
import { type Db, createDb } from '../create-db.js';

/**
 * Open a per-request database handle over a Hyperdrive binding. The caller
 * (the `connectDb` concern in `createServerApp`) closes it after the
 * after-response queue drains.
 */
export async function connectHyperdriveDb(
	hyperdrive: Hyperdrive,
): Promise<{ db: Db; close: () => Promise<void> }> {
	const client = new pg.Client({
		connectionString: hyperdrive.connectionString,
	});
	await client.connect();
	return { db: createDb(client), close: () => client.end() };
}
