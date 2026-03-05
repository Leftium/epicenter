import type { AppEnv } from '../worker';
import type { Context } from 'hono';

export function createMigrateHandler() {
	return async (c: Context<AppEnv>) => {
		const auth = c.get('auth');
		// @ts-expect-error — better-auth/db/migration has no published types but works at runtime
		const { getMigrations } = (await import('better-auth/db/migration')) as {
			getMigrations: (options: unknown) => Promise<{
				toBeCreated: { table: string }[];
				toBeAdded: { table: string }[];
				runMigrations: () => Promise<void>;
			}>;
		};
		const { toBeCreated, toBeAdded, runMigrations } =
			await getMigrations(auth.options);

		if (toBeCreated.length === 0 && toBeAdded.length === 0) {
			return c.json({ message: 'No migrations needed' });
		}

		await runMigrations();
		return c.json({
			message: 'Migrations completed',
			created: toBeCreated.map((t: { table: string }) => t.table),
			added: toBeAdded.map((t: { table: string }) => t.table),
		});
	};
}
