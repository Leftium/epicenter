/**
 * Batches: ordered mutation intents collected synchronously (ADR-0482).
 *
 * A batch callback receives a collector and names mutations on it. Nothing is
 * published while it runs. When it returns, the collector is sealed and the
 * folder publishes every collected intent through one application of its file
 * boundary. The collector has no reads, no Git, and no way to wait: it only
 * records what to publish.
 *
 * Bytes are copied when an intent is collected, so what is published and what
 * the receipt's captures describe are the bytes the caller passed at that
 * moment.
 */
import type {
	CreateRowOf,
	DataDefinition,
	ParsedDataDefinition,
} from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileWriteIntent, FolderStorage } from './boundary.js';
import {
	type FileCapture,
	fileCapture,
	hashBytes,
	ownBytes,
	ownCapture,
} from './capture.js';
import { BatchError, FileError, type TableError } from './errors.js';
import { pathProblem } from './paths.js';
import type { DeepReadonly } from './reading.js';
import { prepareRow, tableFilenames } from './table.js';

/** A batched row is refused for the values it was given, or as any file is. */
export type BatchRefusal =
	| FileError
	| Extract<TableError, { name: 'InvalidValues' }>;

/** The file verbs of `folder.files`, as intents. Each returns nothing. */
export type BatchFiles = {
	create(path: string, content: string | Uint8Array): void;
	replace(file: FileCapture, content: string | Uint8Array): void;
	remove(file: FileCapture): void;
	move(file: FileCapture, destination: string): void;
	overwrite(path: string, content: string | Uint8Array): void;
};

export type BatchTable<TFields> = {
	/**
	 * Create a row at a stem the caller chose. The collector reads nothing, so
	 * it generates no stem. Before the batch is published, the row's
	 * destination is looked for once: a file already at that exact path
	 * refuses the whole batch. Any other identity the backing filesystem gives
	 * names is its publication's to refuse.
	 */
	create(input: {
		readonly stem: string;
		readonly fields: DeepReadonly<TFields>;
		readonly body?: string;
	}): void;
};

export type FolderBatch<TDefinition extends DataDefinition> = {
	readonly files: BatchFiles;
	readonly tables: {
		readonly [K in keyof TDefinition['tables']]: BatchTable<
			CreateRowOf<TDefinition['tables'][K]>
		>;
	};
};

/** One landed step and the capture it left behind. A removal leaves none. */
export type BatchLanded =
	| {
			readonly kind: 'write';
			readonly path: string;
			readonly file: FileCapture;
	  }
	| {
			readonly kind: 'move';
			readonly from: string;
			readonly to: string;
			readonly file: FileCapture;
	  }
	| { readonly kind: 'remove'; readonly path: string };

/**
 * What a complete batch published, in the order it was collected. Each
 * capture is computed from the collected bytes, or from the moved file's
 * captured hash; none is read back from the folder.
 */
export type BatchReceipt = { readonly steps: readonly BatchLanded[] };

/** A collected intent: a file change whose write hash is not yet computed. */
export type BatchIntent =
	| (FileWriteIntent & { row?: string })
	| { kind: 'remove'; path: string; expectedSha256: string }
	| { kind: 'move'; from: string; to: string; expectedSha256: string };

/** Prepared batch operations retain the captured hash for move receipts. */
export type BatchChange =
	| (FileWriteIntent & { sha256: string })
	| Extract<BatchIntent, { kind: 'remove' | 'move' }>;

/**
 * Refuse a typed row creation whose exact destination is occupied, against
 * the table directory as it will be when that step runs.
 *
 * Each table's filenames are read once. The plan is then walked in order: a
 * removal or a move earlier in the batch frees its name, and a write or a
 * move adds one, so a row may take the place of a row the same batch retires,
 * and two collected rows at one path are refused. Nothing is published
 * before this returns, so a refusal here wrote nothing.
 *
 * Names are compared exactly; there is no case or Unicode folding. This
 * reads names once and another program can still race it. Each creation's
 * own condition at publication is unchanged, and it is where a filesystem
 * that treats two spellings as one file refuses the second.
 */
export async function checkRowDestinations(
	intents: readonly BatchIntent[],
	boundary: Pick<FolderStorage, 'children'>,
): Promise<Result<undefined, FileError>> {
	const names = new Map<string, Set<string>>();
	for (const intent of intents) {
		if (
			intent.kind === 'remove' ||
			intent.kind === 'move' ||
			intent.row === undefined
		)
			continue;
		if (names.has(intent.row)) continue;
		const found = await tableFilenames(boundary, intent.row);
		if (found.error) return found;
		names.set(intent.row, new Set(found.data));
	}
	/** The watched table and filename a path is directly in, if any. */
	const placeOf = (path: string) => {
		const slash = path.lastIndexOf('/');
		const table = names.get(path.slice(0, slash < 0 ? 0 : slash));
		return table === undefined
			? undefined
			: { table, filename: path.slice(slash + 1) };
	};
	for (const intent of intents) {
		if (intent.kind !== 'remove' && intent.kind !== 'move') {
			const place = placeOf(intent.path);
			if (intent.row !== undefined && place?.table.has(place.filename))
				return FileError.Exists({ path: intent.path });
			place?.table.add(place.filename);
			continue;
		}
		const from = placeOf(intent.kind === 'move' ? intent.from : intent.path);
		from?.table.delete(from.filename);
		if (intent.kind === 'move') {
			const to = placeOf(intent.to);
			to?.table.add(to.filename);
		}
	}
	return Ok(undefined);
}

/** The file change an intent becomes once its bytes are hashed. */
export async function toChange(intent: BatchIntent): Promise<BatchChange> {
	if (intent.kind === 'remove' || intent.kind === 'move') return intent;
	const { row, ...change } = intent;
	return { ...change, sha256: await hashBytes(intent.bytes) };
}

export function receiptOf(changes: readonly BatchChange[]): BatchReceipt {
	return Object.freeze({
		steps: Object.freeze(
			changes.map((change): BatchLanded => {
				if (change.kind !== 'remove' && change.kind !== 'move')
					return Object.freeze({
						kind: 'write',
						path: change.path,
						file: fileCapture(change.path, change.sha256),
					});
				if (change.kind === 'move')
					return Object.freeze({
						kind: 'move',
						from: change.from,
						to: change.to,
						// A batch only moves a captured file, so its hash is known.
						file: fileCapture(change.to, change.expectedSha256),
					});
				return Object.freeze({ kind: 'remove', path: change.path });
			}),
		),
	});
}

type Refusal = Result<never, BatchRefusal>;

/**
 * Run the callback once and return what it collected, or the reason nothing
 * will be published. The collector is sealed before this returns, whatever
 * the callback did.
 */
export function collectBatch<TDefinition extends DataDefinition>(
	compiled: ParsedDataDefinition,
	collect: (batch: FolderBatch<TDefinition>) => undefined,
): Result<readonly BatchIntent[], BatchError | BatchRefusal> {
	const intents: BatchIntent[] = [];
	let refusal: Refusal | undefined;
	let sealed = false;

	function open() {
		if (sealed)
			throw new Error(
				'This batch is sealed. A batch collects mutations only while its callback runs; it cannot be kept or used after an await.',
			);
	}
	/** Remember the first refusal; the batch then publishes nothing. */
	function refuse(result: Refusal) {
		refusal ??= result;
	}
	function checked(path: string): boolean {
		const problem = pathProblem(path);
		if (problem !== undefined)
			refuse(FileError.InvalidPath({ path, reason: problem }));
		return problem === undefined;
	}
	/** A fixed copy of a capture, or undefined after refusing a malformed one. */
	function captured(file: FileCapture): FileCapture | undefined {
		const own = ownCapture(file);
		if (own.error) {
			refuse(own);
			return undefined;
		}
		return checked(own.data.path) ? own.data : undefined;
	}
	function write(change: FileWriteIntent) {
		if (checked(change.path)) intents.push(change);
	}

	const files: BatchFiles = {
		create(path, content) {
			open();
			write({ kind: 'create', path, bytes: ownBytes(content) });
		},
		replace(file, content) {
			open();
			const target = captured(file);
			if (target !== undefined)
				write({
					kind: 'replace',
					path: target.path,
					bytes: ownBytes(content),
					expectedSha256: target.sha256,
				});
		},
		remove(file) {
			open();
			const target = captured(file);
			if (target !== undefined)
				intents.push({
					kind: 'remove',
					path: target.path,
					expectedSha256: target.sha256,
				});
		},
		move(file, destination) {
			open();
			const target = captured(file);
			if (target !== undefined && checked(destination))
				intents.push({
					kind: 'move',
					from: target.path,
					to: destination,
					expectedSha256: target.sha256,
				});
		},
		overwrite(path, content) {
			open();
			write({ kind: 'overwrite', path, bytes: ownBytes(content) });
		},
	};

	const tables: Record<string, BatchTable<unknown>> = {};
	for (const parsed of compiled.tables.values())
		tables[parsed.name] = {
			create(input) {
				open();
				if (typeof input?.stem !== 'string') {
					refuse(
						FileError.InvalidPath({
							path: `${parsed.name}/`,
							reason: 'a batched row is created at a stem the caller supplies',
						}),
					);
					return;
				}
				const prepared = prepareRow(parsed, input);
				if (prepared.error) {
					refuse(Err(prepared.error));
					return;
				}
				// `prepareRow` encoded these bytes itself; no caller holds them.
				intents.push({
					kind: 'create',
					path: prepared.data.path,
					bytes: prepared.data.bytes,
					row: parsed.name,
				});
			},
		};

	let returned: unknown;
	try {
		returned = (collect as (batch: FolderBatch<TDefinition>) => unknown)(
			Object.freeze({
				files: Object.freeze(files),
				tables: Object.freeze(tables),
			}) as FolderBatch<TDefinition>,
		);
	} catch (cause) {
		return BatchError.Threw({ cause });
	} finally {
		sealed = true;
	}
	if (returned !== undefined) {
		const then = (returned as { then?: unknown } | null)?.then;
		const thenable = typeof then === 'function';
		// The promise is not waited for. Its later failure, such as using the
		// sealed collector, is already reported by this refusal.
		if (thenable)
			(then as (onFulfilled: undefined, onRejected: () => void) => void).call(
				returned,
				undefined,
				() => {},
			);
		return BatchError.Returned({ thenable });
	}
	if (refusal !== undefined) return refusal;
	return Ok(intents);
}
