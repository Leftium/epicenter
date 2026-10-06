/**
 * Row editors: the latest complete input of one table row and the writes
 * that save it.
 *
 *     const { data: editor, error } = await folder.tables.todos.edit(stem, { signal });
 *     if (error !== null) return showOpenError(error);
 *     const { get, subscribe, set, setText, retry, waitForSaves, reload } = editor;
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
 * - `row`: the latest input, from acquisition, a setter, or a successful
 *   `reload`. It is always shown; storage never hides it.
 * - `save`: the outcome of the latest attempt. One write runs at a time, and
 *   only the latest text given while it runs waits to follow it.
 *
 * `set` and `setText` take input synchronously. Before either returns, its
 * text is the row snapshot and its write has started or is waiting for the
 * running one: `save` is `saving` until no write runs and none waits, with
 * no idle gap between consecutive writes. Text that a newer setter replaces
 * before its turn is never written. When a write completes, failed or not,
 * the waiting text starts next; a failure with nothing waiting ends `failed`
 * until the next input or `retry` starts another write. Every write
 * replaces the existing row, so a row deleted before its write is
 * `NotFound` and never recreated.
 *
 * The editor never reads storage on its own. It does not watch change hints,
 * and subscribers hear only changes to the snapshot in memory. `reload` is
 * the only read after acquisition. Writes never depend on a subscriber.
 *
 * Methods close over the editor; none reads `this`, so destructuring them is
 * safe. One editor may serve several views; each view subscribes on its own.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
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
import { applyOne } from './storage.js';

const log = createLogger('folder/editor');

export const RowEditorError = defineErrors({
	/** The caller's signal aborted before the editor was acquired. */
	Aborted: ({ path }: { path: string }) => ({
		message: `Opening '${path}' was aborted`,
		path,
	}),
	/** `set` was given a row with no canonical form. Input and writes are unchanged. */
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
	 * A setter or `retry` ran while `reload` ran. The file's text was not
	 * adopted; the newer input and its save state stand.
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

/** Why the input supports raw repair but no structured form. */
export type RowError = RowEditorErrorOf<
	'Unencodable' | 'NoCanonicalForm' | 'Nonconforming'
>;

/** Why `set` changed nothing. */
export type RowSetError = RowEditorErrorOf<'Unrepresentable'>;

/**
 * Why the latest attempt saved nothing. `Unconfirmed` means the write may
 * have landed: present it as uncertainty, never as a definite failure.
 */
export type RowSaveError = FileError | RowEditorErrorOf<'Unencodable'>;

/** Why `reload` adopted nothing: the row could not be read, or the editor's input changed. */
export type RowReloadError = TableReadError | RowEditorErrorOf<'InputChanged'>;

/**
 * The latest input. Both variants derive wholly from one text;
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

/**
 * `saving` while a write runs or waits; otherwise the latest attempt's
 * outcome. A failure stays visible while newer input saves. Success clears it.
 */
export type SaveState =
	| { readonly status: 'idle' }
	| {
			readonly status: 'saving';
			/** A previous attempt failed; a newer successful save clears it. */
			readonly error?: RowSaveError;
	  }
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
	 * Set a complete row: every field to keep and the body. Only `fields`
	 * and `body` are read, so a valid row can be passed back with changes;
	 * its `status` and `text` are ignored. Omitted keys are deleted; nothing
	 * is merged from disk or earlier input. The values are formatted
	 * canonically before this returns, so later changes to the caller's
	 * objects change nothing held or waiting. Schema-invalid values are
	 * kept and saved; `Unrepresentable` changes nothing.
	 */
	set(next: CanonicalDocument): Result<undefined, RowSetError>;
	/**
	 * Set raw text exactly as given, malformed frontmatter included. Text
	 * UTF-8 cannot encode exactly is held as invalid input and fails its
	 * turn with `Unencodable` instead of writing lossy bytes.
	 */
	setText(text: string): void;
	/**
	 * Save the current input again after a failure, even when it is the text
	 * that failed. A new attempt never confirms an older uncertain one. Does
	 * nothing unless `save` is `failed`.
	 */
	retry(): void;
	/**
	 * Wait until no write runs or waits, including writes of input set
	 * meanwhile, a subscriber's included. `Ok` when the last attempt saved;
	 * its error when it failed, at once if no write runs. Never starts a write.
	 */
	waitForSaves(): Promise<Result<undefined, RowSaveError>>;
	/**
	 * Read the row again and adopt its text, discarding retained input and
	 * any save failure. It first waits as `waitForSaves` does. A read failure
	 * adopts nothing and leaves `row` and `save` as they are. A setter or
	 * `retry` after the call is `InputChanged`: the newer input stands. When
	 * reloads overlap, the latest call decides, and the earlier ones resolve
	 * with its result.
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
	 * The complete parse of one text, whichever setter supplied it: whether it
	 * has a canonical form and whether its declared fields conform. Valid
	 * fields and body come from that text's own parse, so they always
	 * describe it.
	 */
	function parseRow(text: string): RowState<TFields> {
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

	let state: State = Object.freeze({ row: parseRow(acquired), save: IDLE });

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

	// --- Writes ----------------------------------------------------------

	/**
	 * The one running write. Defined exactly while `save` is `saving`; it
	 * resolves after whatever follows it is installed.
	 */
	let writeInFlight: Promise<void> | undefined;
	/** Whether the current row's text must follow the running write. */
	let pendingWrite = false;
	// Counts setters and retries, which a reload must not overwrite even when
	// they leave the snapshot as it was.
	let inputRevision = 0;

	function setText(text: string) {
		inputRevision += 1;
		const next = parseRow(text);
		if (writeInFlight !== undefined) {
			pendingWrite = true;
			commit({ row: next });
		} else {
			commit({
				row: next,
				save: startWrite(
					next,
					state.save.status === 'idle' ? undefined : state.save.error,
				),
			});
		}
	}

	/**
	 * Start writing the interpreted input, or fail with its encoding refusal.
	 * The write is installed before this returns, so before any subscriber
	 * hears the state that names it.
	 *
	 * When the write completes, failed or not, the waiting text starts next;
	 * with nothing waiting, its outcome is the save state. The next write is
	 * installed before subscribers hear anything, so input they set waits
	 * behind it.
	 */
	function startWrite(
		input: RowState<TFields>,
		previousError?: RowSaveError,
	): SaveState {
		if (input.status === 'invalid' && input.error.name === 'Unencodable')
			return Object.freeze({
				status: 'failed',
				error: input.error,
			});
		writeInFlight = write(input.text).then((error) => {
			writeInFlight = undefined;
			// Setters own the latest text; reload cannot adopt until writes settle.
			const next = pendingWrite ? state.row : undefined;
			pendingWrite = false;
			if (next === undefined) {
				commit({
					save:
						error === null ? IDLE : Object.freeze({ status: 'failed', error }),
				});
				return;
			}
			// Keep a failed attempt visible while the newer document saves.
			// A successful attempt clears any previous failure.
			if (error !== null) log.warn(error);
			commit({ save: startWrite(next, error ?? undefined) });
		});
		return previousError === undefined
			? SAVING
			: Object.freeze({ status: 'saving', error: previousError });
	}

	/** Write one capture over the existing row. Never throws. */
	async function write(text: string): Promise<RowSaveError | null> {
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
			const { error } = await applyOne(row.storage, {
				kind: 'replace',
				path,
				bytes,
				sha256,
			});
			return error;
		} catch (cause) {
			// Storage reports outcomes as Results; a throw is a bug whose write
			// may or may not have landed.
			log.error(new Error(`Writing '${path}' threw.`, { cause }));
			return FileError.Unconfirmed({ path, operation: 'replace', cause }).error;
		}
	}

	/** Wait until no write runs or waits, then report the latest attempt. */
	async function waitForSaves(): Promise<Result<undefined, RowSaveError>> {
		while (writeInFlight !== undefined) await writeInFlight;
		const { save } = state;
		return save.status === 'failed' ? Err(save.error) : Ok(undefined);
	}

	// --- Reload ----------------------------------------------------------

	/** The latest `reload` call. An earlier call that overlaps it resolves with its result. */
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
			setText(text);
			return Ok(undefined);
		},
		setText,
		retry(): void {
			if (state.save.status !== 'failed') return;
			inputRevision += 1;
			commit({ save: startWrite(state.row, state.save.error) });
		},
		waitForSaves,
		reload(): Promise<Result<undefined, RowReloadError>> {
			const revision = inputRevision;
			const readAndAdopt = async (): Promise<
				Result<undefined, RowReloadError>
			> => {
				// A save failure is fine: adoption discards it explicitly. With
				// nothing writing, the read starts before `reload` returns.
				if (writeInFlight !== undefined) await waitForSaves();
				const read =
					inputRevision === revision
						? await readText(row)
						: RowEditorError.InputChanged({ path });
				if (latestReload !== reloading) return latestReload;
				const { data: text, error } = read;
				if (error !== null) return Err(error);
				if (inputRevision !== revision)
					return RowEditorError.InputChanged({ path });
				commit({
					row: text === state.row.text ? state.row : parseRow(text),
					save: IDLE,
				});
				return Ok(undefined);
			};
			const reloading = readAndAdopt();
			latestReload = reloading;
			return reloading;
		},
	});
}

function describeReading(reading: TableReading<unknown>): string {
	if (reading.parseError !== undefined) return reading.parseError.message;
	return reading.issues.map((issue) => issue.message).join('; ');
}
