import { createQbAccess } from '../books/qb-access.ts';
import {
	parseRecategorizeEntity,
	recategorizeExpense,
} from '../books/recategorize.ts';
import type { ParsedArgs } from '../cli.ts';
import { dbPath } from '../paths.ts';
import { resolveCompany } from './context.ts';

/**
 * `local-books recategorize <Purchase|Bill> <id> --to <accountId>`: move an
 * expense to a different account in QuickBooks (write-through), then fold the
 * authoritative response into the mirror. Running this verb is the approval; it
 * is refused under `LOCAL_BOOKS_READ_ONLY`.
 */
export async function runRecategorize(args: ParsedArgs): Promise<number> {
	const [entityName, id] = args.positionals;
	if (!entityName || !id || !args.to) {
		console.error(
			'Usage: local-books recategorize <Purchase|Bill> <id> --to <accountId> [--to-name <name>] [--line <lineId>]',
		);
		return 1;
	}

	const { data: entity, error: entityError } =
		parseRecategorizeEntity(entityName);
	if (entityError !== null) {
		console.error(entityError.message);
		return 1;
	}

	const { data: company, error } = resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, store } = company;

	if (config.readOnly) {
		console.error(
			'Refusing to write: LOCAL_BOOKS_READ_ONLY is set, so recategorize is disabled (reads only).',
		);
		return 1;
	}

	const openQb = createQbAccess({ config, realmId, store, now: () => Date.now() });
	const { data, error: writeError } = await recategorizeExpense({
		openQb,
		dbPath: dbPath(config.dataDir, realmId),
		input: {
			entity,
			id,
			account_id: args.to,
			account_name: args.toName,
			line_id: args.line,
		},
	});
	if (writeError !== null) {
		console.error(writeError.message);
		return 1;
	}

	for (const change of data.changed) {
		const line = change.lineId ? ` line ${change.lineId}` : '';
		console.log(
			`${data.entity} ${data.id}${line}: ${change.fromAccount ?? '(none)'} -> ${change.toAccount}`,
		);
	}
	console.error(
		`Updated in QuickBooks (SyncToken ${data.syncToken ?? '?'}) and folded into the mirror.`,
	);
	return 0;
}
