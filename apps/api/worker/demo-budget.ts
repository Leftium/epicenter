/**
 * The shared attempt budget for the anonymous Zhongwen demo generation route
 * (`demo-inference.ts`), in one Durable Object.
 *
 * The demo route has no principal to meter, so its spend cap is global: every
 * anonymous attempt from every isolate goes through the one object named
 * {@link DEMO_BUDGET_OBJECT_NAME}. A Durable Object is single-threaded and its
 * SQLite storage survives eviction, so the counts below are exact across
 * concurrent callers and restarts. An in-memory counter would be per isolate
 * and would not cap anything.
 *
 * Two fixed windows apply together: {@link DEMO_BUDGET.perMinute} attempts per
 * clock minute and {@link DEMO_BUDGET.perDay} per UTC day. An attempt is
 * counted when it is admitted, before the provider is called, so a failed or
 * abandoned generation still spends its slot. A denied attempt spends nothing.
 */
import { DurableObject } from 'cloudflare:workers';

export const DEMO_BUDGET = { perMinute: 10, perDay: 100 } as const;

/** Server-owned and fixed: no request value reaches the object name. */
export const DEMO_BUDGET_OBJECT_NAME = 'demo-generation-budget/global';

const MINUTE_MS = 60_000;
// Epoch milliseconds count UTC days exactly, so flooring by a day is UTC midnight.
const DAY_MS = 86_400_000;

export type DemoBudgetDecision =
	| { allowed: true }
	| { allowed: false; retryAfterSeconds: number };

type WindowRow = { scope: string; window_start: number; count: number };

export class DemoGenerationBudget extends DurableObject {
	private readonly storage: DurableObjectStorage;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.storage = ctx.storage;
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS _demo_budget_windows (
				scope        TEXT    NOT NULL PRIMARY KEY,
				window_start INTEGER NOT NULL,
				count        INTEGER NOT NULL
			)
		`);
	}

	/** Admit and count one attempt, or deny it without counting. */
	consume(): DemoBudgetDecision {
		const now = Date.now();
		return this.storage.transactionSync(() => {
			const windows = [
				{ scope: 'minute', length: MINUTE_MS, limit: DEMO_BUDGET.perMinute },
				{ scope: 'day', length: DAY_MS, limit: DEMO_BUDGET.perDay },
			].map((window) => {
				const start = Math.floor(now / window.length) * window.length;
				const row = [
					...this.storage.sql.exec(
						'SELECT scope, window_start, count FROM _demo_budget_windows WHERE scope = ?',
						window.scope,
					),
				][0] as WindowRow | undefined;
				// A row from an earlier window is a count that has already reset.
				const count = row?.window_start === start ? row.count : 0;
				return { ...window, start, count };
			});

			const exhausted = windows.filter(
				(window) => window.count >= window.limit,
			);
			if (exhausted.length > 0) {
				const resetAt = Math.max(
					...exhausted.map((window) => window.start + window.length),
				);
				return {
					allowed: false,
					retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
				};
			}

			for (const window of windows) {
				this.storage.sql.exec(
					`INSERT INTO _demo_budget_windows (scope, window_start, count)
					 VALUES (?, ?, ?)
					 ON CONFLICT (scope) DO UPDATE SET
					   window_start = excluded.window_start,
					   count = excluded.count`,
					window.scope,
					window.start,
					window.count + 1,
				);
			}
			return { allowed: true };
		});
	}
}
