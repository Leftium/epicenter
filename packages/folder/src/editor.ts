/**
 * Row editors: the accepted complete input of one table row and one queue
 * that publishes it.
 *
 *     const { data: editor, error } = await folder.tables.todos.edit(stem, { signal });
 *     if (error !== null) return showOpenError(error);
 *     const { get, subscribe, set, setText, retry, flush, reload } = editor;
 *
 * The table that owns the row supplies its path, schema, and declared field
 * order, so an editor is acquired only through `table.edit`. Acquisition
 * reads the row once. Readable text yields an editor whether or not it
 * conforms, so malformed or schema-invalid text can be repaired through the
 * same owner. A missing, unreadable, or non-UTF-8 file, an address the folder
 * does not admit, and an aborted acquisition yield none.
 *
 * A row is valid when its text has a canonical form and the complete parse's
 * own declared fields conform. The `fields` a valid row exposes are the
 * values that were checked.
 *
 * The snapshot holds two facts:
 *
 * - `row`: the latest accepted input, from acquisition, a setter, or a
 *   successful `reload`. It is always shown; storage never hides it.
 * - `save`: the publication chain. One write runs at a time, and the latest
 *   input accepted while it runs follows it.
 *
 * `set` and `setText` accept input synchronously. Before either returns, the
 * accepted text is the row snapshot and, unless the chain is paused, its
 * save is admitted: `save` is `saving` from admission until the chain
 * settles, with no idle gap between consecutive writes. Input that a newer
 * setter supersedes before its turn is never submitted. A failed or
 * unconfirmed write pauses the chain: newer input is kept and not attempted
 * until `retry`. Every write replaces the existing row, so a row deleted
 * before publication is `NotFound` and never recreated.
 *
 * The editor never reads storage on its own. It does not watch change hints,
 * and subscribers hear only changes to the snapshot in memory. `reload` is
 * the only read after acquisition. Publication never depends on a
 * subscriber.
 *
 * Methods close over the editor; none reads `this`, so destructuring them is
 * safe. One editor may serve several views; each view subscribes on its own.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage, Submission } from './boundary.js';
import {
	type CanonicalDocument,
	type CanonicalRefusal,
	formatCanonicalDocument,
	parseCanonicalDocument,
} from './canonical.js';
import { hashBytes } from './capture.js';
import { FileError, TableError, type TableReadError } from './errors.js';
import { callObserver } from './observer.js';
import { type DeepReadonly, freezeDeep } from './reading.js';
import type { TableReading } from './row-text.js';
import { applyOne, reserveSubmission } from './storage.js';

const log = createLogger('folder/editor');

export const RowEditorError = defineErrors({
	/** The caller's signal aborted before the editor was acquired. */
	Aborted: ({ path }: { path: string }) => ({
		message: `Opening '${path}' was aborted`,
		path,
	}),
	/** `set` was given a row with no canonical form. Input and publication are unchanged. */
	Unrepresentable: ({
		path,
		refusal,
	}: {
		path: string;
		refusal: CanonicalRefusal;
	}) => ({
		message: `The row for '${path}' cannot be saved: ${refusal.reason}`,
		path,
		refusal,
	}),
	/**
	 * The text contains a lone surrogate, which UTF-8 cannot encode exactly.
	 * The text is kept as it was given and never written.
	 */
	Unencodable: ({ path }: { path: string }) => ({
		message: `The text for '${path}' contains a lone surrogate, which UTF-8 cannot encode exactly`,
		path,
	}),
	/** The text is readable but has no canonical form, such as malformed frontmatter or a custom tag. */
	NoCanonicalForm: ({
		path,
		refusal,
	}: {
		path: string;
		refusal: CanonicalRefusal;
	}) => ({
		message: `'${path}' has no canonical form: ${refusal.reason}`,
		path,
		refusal,
	}),
	/**
	 * The text has a canonical form, but a declared field of its complete
	 * parse does not conform or is missing. `reading` lists every issue and
	 * the declared fields that do conform; it never has a `parseError`.
	 */
	Nonconforming: ({
		path,
		reading,
	}: {
		path: string;
		reading: TableReading<unknown>;
	}) => ({
		message: `'${path}' is not a valid row: ${describeReading(reading)}`,
		path,
		reading,
	}),
	/**
	 * Input was accepted or a save was admitted while `reload` ran. The file's
	 * text was not adopted; the newer input and its save state stand.
	 */
	InputChanged: ({ path }: { path: string }) => ({
		message: `'${path}' changed in the editor while it was being reloaded`,
		path,
	}),
});
export type RowEditorError = InferErrors<typeof RowEditorError>;
type RowEditorErrorOf<TName extends RowEditorError['name']> = Extract<
	RowEditorError,
	{ name: TName }
>;

/**
 * Why `table.edit` acquired no editor. An address the folder does not admit
 * is `InvalidPath` and an absent row is `NotFound`, both from `FileError`.
 * Readable text that does not conform is not a refusal: it opens for repair.
 */
export type TableEditError = TableReadError | RowEditorErrorOf<'Aborted'>;

/** Why accepted input supports raw repair but no structured form. */
export type RowError = RowEditorErrorOf<
	'Unencodable' | 'NoCanonicalForm' | 'Nonconforming'
>;

/** Why `set` accepted nothing. */
export type RowSetError = RowEditorErrorOf<'Unrepresentable'>;

/**
 * Why the publication chain stopped. `Unconfirmed` means the write may have
 * landed: present it as uncertainty, never as a definite failure.
 */
export type RowSaveError = FileError | RowEditorErrorOf<'Unencodable'>;

/** Why `reload` adopted nothing: the row could not be read, or the editor's input changed. */
export type RowReloadError = TableReadError | RowEditorErrorOf<'InputChanged'>;

/**
 * The latest accepted input. Both variants derive wholly from one text;
 * `valid` adds its complete parse, unknown metadata included.
 */
export type RowState<TFields> =
	| {
			readonly status: 'valid';
			readonly text: string;
			readonly fields: DeepReadonly<TFields> & CanonicalDocument['fields'];
			readonly body: string;
	  }
	| {
			readonly status: 'invalid';
			readonly text: string;
			readonly error: RowError;
	  };

/** The publication chain: `saving` from admission until it settles; `failed` until `retry` or `reload`. */
export type SaveState =
	| { readonly status: 'idle' }
	| { readonly status: 'saving' }
	| { readonly status: 'failed'; readonly error: RowSaveError };

/** One immutable snapshot. `get` returns the same object until either part changes. */
export type RowEditorState<TFields> = {
	readonly row: RowState<TFields>;
	readonly save: SaveState;
};

export type RowEditor<TFields> = {
	/** The current snapshot, from memory. Never reads storage. */
	get(): RowEditorState<TFields>;
	/**
	 * Call `invalidate` after the snapshot changes; read it with `get`.
	 * There is no initial call, and subscribing reads and watches nothing.
	 * Delivery is never reentrant, and what a listener throws is logged and
	 * reaches no operation or other listener. Each call is its own
	 * subscription; the returned function ends only that one.
	 */
	subscribe(invalidate: () => void): () => void;
	/**
	 * Accept a complete row: every field to keep and the body. Only `fields`
	 * and `body` are read, so a valid row can be passed back with changes;
	 * its `status` and `text` are ignored. Omitted keys are deleted; nothing
	 * is merged from disk or earlier input. The values are formatted
	 * canonically before this returns, so later changes to the caller's
	 * objects change nothing held or queued. Schema-invalid values are
	 * accepted and saved; `Unrepresentable` accepts nothing.
	 */
	set(next: CanonicalDocument): Result<undefined, RowSetError>;
	/**
	 * Accept raw text exactly as given, malformed frontmatter included. Text
	 * UTF-8 cannot encode exactly is held as invalid input and fails its
	 * publication turn with `Unencodable` instead of writing lossy bytes.
	 */
	setText(text: string): void;
	/**
	 * Resume a failed chain with the latest accepted input, even when it is
	 * the text that failed. A new attempt never confirms an older uncertain
	 * one. Does nothing unless `save` is `failed`.
	 */
	retry(): void;
	/**
	 * Wait for the running chain, including input admitted while it runs, to
	 * settle. `Ok` when it ends idle; the chain's error when it ends failed or
	 * was already failed. Never starts a write.
	 */
	flush(): Promise<Result<undefined, RowSaveError>>;
	/**
	 * Read the row again and adopt its text, discarding retained input and
	 * any save failure. It first waits for the running chain to settle. A read
	 * failure adopts nothing and leaves `row` and `save` as they are. Input
	 * accepted or a save admitted after the call is `InputChanged`: the newer
	 * input stands. When reloads overlap, the latest call decides, and the
	 * earlier ones settle with its result.
	 */
	reload(): Promise<Result<undefined, RowReloadError>>;
};

/** What the table that owns a row gives the row's editor. */
type EditedRow<TFields> = {
	readonly path: string;
	readonly storage: Pick<FolderStorage, 'read' | 'apply'>;
	/** The table's declared field names, in declared order. */
	readonly declaredKeys: readonly string[];
	/** Check already parsed, frozen values against the table's prepared fields. */
	conform(
		values: CanonicalDocument['fields'],
		body: string,
	): TableReading<TFields>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Read the row's text once. Never throws: a storage that throws is an `Io` failure. */
async function readText<TFields>(
	row: EditedRow<TFields>,
): Promise<Result<string, TableReadError>> {
	const { path } = row;
	let read: Awaited<ReturnType<FolderStorage['read']>>;
	try {
		read = await row.storage.read(path);
	} catch (cause) {
		return FileError.Io({ path, operation: 'read', cause });
	}
	const { data: current, error: readError } = read;
	if (readError !== null) return Err(readError);
	try {
		return Ok(utf8.decode(current.bytes));
	} catch {
		return TableError.InvalidUtf8({ path, sha256: current.sha256 });
	}
}

/** Acquire an editor from one read. `signal` governs acquisition only. */
export async function openRowEditor<TFields>(
	row: EditedRow<TFields>,
	signal: AbortSignal | undefined,
): Promise<Result<RowEditor<TFields>, TableEditError>> {
	const { path } = row;
	if (signal?.aborted) return RowEditorError.Aborted({ path });
	const aborted = Promise.withResolvers<'aborted'>();
	const onAbort = () => aborted.resolve('aborted');
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		const read = await Promise.race([readText(row), aborted.promise]);
		if (read === 'aborted' || signal?.aborted)
			return RowEditorError.Aborted({ path });
		const { data: text, error: readError } = read;
		if (readError !== null) return Err(readError);
		return Ok(createRowEditor(row, text));
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

const IDLE: SaveState = Object.freeze({ status: 'idle' });
const SAVING: SaveState = Object.freeze({ status: 'saving' });

function createRowEditor<TFields>(
	row: EditedRow<TFields>,
	acquired: string,
): RowEditor<TFields> {
	type State = RowEditorState<TFields>;
	const { path } = row;

	/**
	 * The complete interpretation of one text. Valid fields and body come from
	 * that text's own parse, so they always describe it. `canonical` skips
	 * the format check for text `set` just formatted.
	 */
	function interpret(text: string, canonical = false): RowState<TFields> {
		if (!text.isWellFormed())
			return Object.freeze({
				status: 'invalid',
				text,
				error: RowEditorError.Unencodable({ path }).error,
			});
		const { data: parsed, error: parseRefusal } = parseCanonicalDocument(text);
		if (parseRefusal !== null)
			return Object.freeze({
				status: 'invalid',
				text,
				error: RowEditorError.NoCanonicalForm({ path, refusal: parseRefusal })
					.error,
			});
		if (!canonical) {
			// Valid input must survive a structured round trip through `set`.
			const { error: formatRefusal } = formatCanonicalDocument(
				parsed,
				row.declaredKeys,
			);
			if (formatRefusal !== null)
				return Object.freeze({
					status: 'invalid',
					text,
					error: RowEditorError.NoCanonicalForm({
						path,
						refusal: formatRefusal,
					}).error,
				});
		}
		// The parse's own objects: freezing them touches nothing a caller holds,
		// and conformance checks exactly the values a valid row exposes.
		const fields = freezeDeep(parsed.fields);
		const reading = row.conform(fields, parsed.body);
		if (reading.issues.length > 0)
			return Object.freeze({
				status: 'invalid',
				text,
				error: RowEditorError.Nonconforming({ path, reading }).error,
			});
		return Object.freeze({
			status: 'valid',
			text,
			fields: fields as DeepReadonly<TFields> & CanonicalDocument['fields'],
			body: parsed.body,
		});
	}

	// --- The snapshot ----------------------------------------------------

	let state: State = Object.freeze({ row: interpret(acquired), save: IDLE });

	const subscribers = new Set<{ readonly invalidate: () => void }>();
	let delivering = false;
	let redeliver = false;

	/** Install the next snapshot and invalidate subscribers if it changed. */
	function commit(next: { row?: RowState<TFields>; save?: SaveState }) {
		const { row: nextRow = state.row, save = state.save } = next;
		if (nextRow === state.row && save === state.save) return;
		state = Object.freeze({ row: nextRow, save });
		deliver();
	}

	/**
	 * Call every subscriber once per round. A change during delivery starts
	 * another round after the running one, so no listener runs inside itself.
	 */
	function deliver() {
		if (delivering) {
			redeliver = true;
			return;
		}
		delivering = true;
		try {
			do {
				redeliver = false;
				for (const subscriber of [...subscribers]) {
					if (!subscribers.has(subscriber)) continue;
					callObserver(
						'row editor subscriber',
						subscriber.invalidate,
						undefined,
					);
				}
			} while (redeliver);
		} finally {
			delivering = false;
		}
	}

	// --- Publication -----------------------------------------------------

	/**
	 * The running chain, from admission until it settles idle or failed; the
	 * promise is that outcome. Defined exactly while `save` is `saving`.
	 */
	let chain: PromiseWithResolvers<Result<undefined, RowSaveError>> | undefined;
	/**
	 * The place in the page's order of saves reserved for the latest input
	 * accepted while the chain runs. That input is `state.row.text`.
	 */
	let queued: Submission | undefined;
	// A retry can fail synchronously without changing the retained row.
	let inputRevision = 0;

	function accept(text: string, canonical: boolean) {
		inputRevision += 1;
		const accepted = interpret(text, canonical);
		if (chain !== undefined) {
			// Reserved now, so the capture keeps its place when accepted.
			queued = reserveSubmission();
			commit({ row: accepted });
		} else if (state.save.status === 'failed') {
			// Paused: kept, not attempted until `retry`.
			commit({ row: accepted });
		} else {
			commit({ row: accepted, save: start(text, reserveSubmission()) });
		}
	}

	/** Start writing `text`, or fail at once when no bytes encode it exactly. */
	function start(text: string, submission: Submission): SaveState {
		if (!text.isWellFormed())
			return Object.freeze({
				status: 'failed',
				error: RowEditorError.Unencodable({ path }).error,
			});
		chain ??= Promise.withResolvers();
		void publish(text, submission).then(settle);
		return SAVING;
	}

	/** Write one capture over the existing row. Never throws. */
	async function publish(
		text: string,
		submission: Submission,
	): Promise<RowSaveError | null> {
		let bytes: Uint8Array;
		let sha256: string;
		try {
			// Well formed, so these bytes decode back to exactly this text.
			bytes = encoder.encode(text);
			sha256 = await hashBytes(bytes);
		} catch (cause) {
			return FileError.Io({ path, operation: 'prepare', cause }).error;
		}
		try {
			const { error } = await applyOne(
				row.storage,
				{ kind: 'replace', path, bytes, sha256 },
				submission,
			);
			return error;
		} catch (cause) {
			// Storage reports outcomes as Results; a throw is a bug whose write
			// may or may not have landed.
			log.error(new Error(`Publishing '${path}' threw.`, { cause }));
			return FileError.Unconfirmed({ path, operation: 'replace', cause }).error;
		}
	}

	/** Settle the running write: continue with the latest input, or stop. */
	function settle(error: RowSaveError | null) {
		let save: SaveState;
		if (error !== null) {
			// Pause: the latest input stays accepted and is not attempted.
			save = Object.freeze({ status: 'failed', error });
		} else if (queued !== undefined) {
			save = start(state.row.text, queued);
		} else {
			save = IDLE;
		}
		queued = undefined;
		const settled = save.status === 'saving' ? undefined : chain;
		if (settled !== undefined) chain = undefined;
		commit({ save });
		settled?.resolve(outcome(save));
	}

	function outcome(save: SaveState): Result<undefined, RowSaveError> {
		return save.status === 'failed' ? Err(save.error) : Ok(undefined);
	}

	// --- Reload ----------------------------------------------------------

	/**
	 * Wait for the running chain, then read the row, unless input changed
	 * since the call. `before` is the snapshot the read began in.
	 */
	async function readAfterChain(
		revision: number,
	): Promise<Result<{ text: string; before: State }, RowReloadError>> {
		// A failed chain is fine: adoption discards it explicitly.
		if (chain !== undefined) await chain.promise;
		if (inputRevision !== revision || chain !== undefined)
			return RowEditorError.InputChanged({ path });
		const before = state;
		const { data: text, error } = await readText(row);
		if (error !== null) return Err(error);
		return Ok({ text, before });
	}

	/** The latest `reload` call. An earlier call that overlaps it settles with its result. */
	let latestReload: Promise<Result<undefined, RowReloadError>> =
		Promise.resolve(Ok(undefined));

	return Object.freeze({
		get: (): State => state,
		subscribe(invalidate: () => void): () => void {
			const subscriber = { invalidate };
			subscribers.add(subscriber);
			return () => {
				subscribers.delete(subscriber);
			};
		},
		set(next: CanonicalDocument): Result<undefined, RowSetError> {
			// The codec reads only fields and body, once each, so a public row's
			// status and text are not input; it refuses any other shape.
			const { data: text, error: refusal } = formatCanonicalDocument(
				next,
				row.declaredKeys,
			);
			if (refusal !== null)
				return RowEditorError.Unrepresentable({ path, refusal });
			accept(text, true);
			return Ok(undefined);
		},
		setText(text: string): void {
			accept(text, false);
		},
		retry(): void {
			if (state.save.status !== 'failed') return;
			inputRevision += 1;
			commit({ save: start(state.row.text, reserveSubmission()) });
		},
		flush(): Promise<Result<undefined, RowSaveError>> {
			return chain?.promise ?? Promise.resolve(outcome(state.save));
		},
		reload(): Promise<Result<undefined, RowReloadError>> {
			const reloading: Promise<Result<undefined, RowReloadError>> =
				readAfterChain(inputRevision).then(({ data: read, error }) => {
					if (latestReload !== reloading) return latestReload;
					if (error !== null) return Err(error);
					// A setter changes `row`; `retry` changes `save`.
					if (state !== read.before)
						return RowEditorError.InputChanged({ path });
					commit({
						row:
							read.text === state.row.text ? state.row : interpret(read.text),
						save: IDLE,
					});
					return Ok(undefined);
				});
			latestReload = reloading;
			return reloading;
		},
	});
}

function describeReading(reading: TableReading<unknown>): string {
	if (reading.parseError !== undefined) return reading.parseError.message;
	return reading.issues.map((issue) => issue.message).join('; ');
}
