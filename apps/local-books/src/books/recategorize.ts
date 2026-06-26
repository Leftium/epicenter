/**
 * `recategorizeExpense`: the one QuickBooks write-back (ADR-0061's single
 * approved verb). It moves an expense transaction's category by sparse-updating
 * the `AccountRef` on its expense lines, then folds QuickBooks' response back
 * into the local mirror.
 *
 * Write-THROUGH, never write-to-mirror: QuickBooks owns the change; the mirror is
 * updated from the authoritative response (with the bumped `SyncToken`), and the
 * next CDC sync reconfirms it. The mirror is never the write target.
 *
 * Concurrency: the current `SyncToken` is read from the mirror and sent with the
 * update. If a bookkeeper changed the object in QuickBooks since the last sync,
 * QuickBooks rejects the stale token (a 409 `Http` error) rather than clobbering
 * their change; the caller should re-sync and retry.
 *
 * Running the `recategorize` verb is the approval, the human gate ADR-0072 keeps
 * in place of the daemon loop's synchronous approval pause.
 *
 * Read-only is a CORE invariant, not an adapter check: the write is refused here
 * (the single owner) when `readOnly` is set, so the verb-core seam ADR-0072
 * promises is safe to wrap. A future daemon/MCP adapter over this core cannot
 * forget the gate and move money, because `readOnly` is a required argument.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import type { QbClientError } from '../qb-client.ts';
import type { OpenQbClient } from './qb-access.ts';

/** The line shape that carries an account-based expense category. */
const LINE_DETAIL = 'AccountBasedExpenseLineDetail';

/** The expense transactions a recategorize can target. */
export const RECATEGORIZE_ENTITIES = ['Purchase', 'Bill'] as const;
export type RecategorizeEntity = (typeof RECATEGORIZE_ENTITIES)[number];

export const RecategorizeError = defineErrors({
	ReadOnly: () => ({
		message:
			'Refusing to write: read-only mode is set (LOCAL_BOOKS_READ_ONLY), so recategorize is disabled. query and report stay available.',
	}),
	UnknownEntity: ({ name }: { name: string }) => ({
		message: `recategorize targets a Purchase (card/cash/check expense) or a Bill (vendor bill), not "${name}".`,
	}),
	NotAuthenticated: ({ detail }: { detail: string }) => ({
		message: `Recategorize could not reach QuickBooks: ${detail}`,
		detail,
	}),
	NotInMirror: ({ entity, id }: { entity: string; id: string }) => ({
		message: `No ${entity} ${id} in the local mirror. Run "local-books sync" first.`,
	}),
	NoExpenseLine: ({
		entity,
		id,
		lineId,
	}: {
		entity: string;
		id: string;
		lineId?: string;
	}) => ({
		message: lineId
			? `${entity} ${id} has no expense line ${lineId} to recategorize.`
			: `${entity} ${id} has no account-based expense line to recategorize.`,
	}),
});
export type RecategorizeError = InferErrors<typeof RecategorizeError>;

export type RecategorizeInput = {
	entity: RecategorizeEntity;
	/** The QuickBooks Id of the transaction (the mirror row `id`). */
	id: string;
	/** The target expense account Id, set as the line AccountRef.value. */
	account_id: string;
	/** The target account display name, set as AccountRef.name (readable books). */
	account_name?: string;
	/** Recategorize only this line (its `Id`); omit for every expense line. */
	line_id?: string;
};

export type RecategorizeChange = {
	lineId: string | null;
	fromAccount: string | null;
	toAccount: string;
};

export type RecategorizeResult = {
	entity: RecategorizeEntity;
	id: string;
	changed: RecategorizeChange[];
	syncToken: string | null;
};

type ExpenseLine = Record<string, unknown> & {
	Id?: string | number;
	[LINE_DETAIL]?: { AccountRef?: { value?: string; name?: string } };
};

/** Validate a raw entity name against the closed set, the verb's parse step. */
export function parseRecategorizeEntity(
	name: string,
): Result<RecategorizeEntity, RecategorizeError> {
	if ((RECATEGORIZE_ENTITIES as readonly string[]).includes(name)) {
		return Ok(name as RecategorizeEntity);
	}
	return RecategorizeError.UnknownEntity({ name });
}

export async function recategorizeExpense({
	openQb,
	dbPath,
	input,
	readOnly,
}: {
	openQb: OpenQbClient;
	dbPath: string;
	input: RecategorizeInput;
	/**
	 * Whether writes are forbidden. Required (no default) so every caller, the
	 * CLI today and any future daemon/MCP adapter, must decide explicitly; a
	 * wrapper cannot silently skip the gate. This core is the single owner of the
	 * read-only invariant.
	 */
	readOnly: boolean;
}): Promise<Result<RecategorizeResult, RecategorizeError | QbClientError>> {
	if (readOnly) return RecategorizeError.ReadOnly();
	const def = entityDef(input.entity);
	const db = openBooksDb(dbPath);
	try {
		const raw = db.getLiveRaw(def, input.id);
		if (raw === null) {
			return RecategorizeError.NotInMirror({
				entity: input.entity,
				id: input.id,
			});
		}

		const obj = JSON.parse(raw) as Record<string, unknown>;
		const lines: ExpenseLine[] = Array.isArray(obj.Line)
			? (obj.Line as ExpenseLine[])
			: [];
		const targets = lines.filter(
			(line) =>
				line[LINE_DETAIL] != null &&
				(input.line_id == null || String(line.Id) === input.line_id),
		);
		if (targets.length === 0) {
			return RecategorizeError.NoExpenseLine({
				entity: input.entity,
				id: input.id,
				lineId: input.line_id,
			});
		}

		const toName = input.account_name ?? input.account_id;
		const changed: RecategorizeChange[] = targets.map((line) => {
			const detail = line[LINE_DETAIL];
			const fromRef = detail?.AccountRef;
			const change: RecategorizeChange = {
				lineId: line.Id != null ? String(line.Id) : null,
				fromAccount: fromRef?.name ?? fromRef?.value ?? null,
				toAccount: toName,
			};
			line[LINE_DETAIL] = {
				...detail,
				AccountRef: {
					value: input.account_id,
					...(input.account_name ? { name: input.account_name } : {}),
				},
			};
			return change;
		});

		const { data: qb, error: openError } = await openQb();
		if (openError !== null) {
			return RecategorizeError.NotAuthenticated({ detail: openError });
		}

		// Sparse update: send the full (modified) Line array with Id + the SyncToken
		// read from the mirror; QuickBooks merges the named fields.
		const { data: updated, error } = await qb.update(input.entity, {
			Id: obj.Id,
			SyncToken: obj.SyncToken,
			sparse: true,
			Line: lines,
		});
		// Re-wrap as a Result: a bare error variant would be Ok-wrapped and read as
		// success. A stale SyncToken (409) lands here.
		if (error) return Err(error);

		// QuickBooks has committed the change, so the operation has succeeded. Fold
		// the authoritative response into the mirror through the shared monotonic
		// ingest so a read sees it immediately. Best-effort: if it cannot write (a
		// concurrent sync holding the lock past busy_timeout, a disk error), the next
		// monotonic CDC sync reconciles the row, and the successful QuickBooks write
		// must not be reported as a failure (which would invite a retry that hits a
		// 409 on the now-bumped token).
		trySync({
			try: () =>
				db.ingest([{ def, objects: [updated] }], {
					syncedAt: new Date().toISOString(),
				}),
			catch: (cause) => Err(cause),
		});

		return Ok({
			entity: input.entity,
			id: String(updated.Id),
			changed,
			syncToken:
				typeof updated.SyncToken === 'string' ? updated.SyncToken : null,
		});
	} finally {
		db.close();
	}
}
