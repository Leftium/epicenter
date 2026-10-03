/**
 * EXPERIMENT: a canonical document editor for one table row. Evidence for a
 * future editing API, not part of `@epicenter/folder`.
 *
 *     const editors = createCanonicalEditors(folder, definition);
 *     const { data: editor, error } = await editors.tables.todos.edit(stem, { signal });
 *     if (error !== null) return showOpenError(error);
 *     const { get, subscribe, change, save, refresh, adopt, dispose } = editor;
 *
 * The editor owns three values and keeps them apart:
 *
 * - `baseline`: the revision `isDirty` compares against. It moves when a
 *   clean editor follows a valid read, when a read matches the local
 *   document, on a save receipt, and on `adopt`.
 * - `document`: the local fields and body. Changes may make it schema
 *   invalid; a read never resets dirty input.
 * - `observation`: what the latest read found, present or not. It is the
 *   truth about the file; the editor never invents one.
 *
 * Dirty is semantic: the local document's canonical text differs from the
 * baseline's. External change is exact: a read's SHA-256 differs from the
 * baseline's. A save always writes the complete canonical document at the
 * row's path with `files.overwrite`; nothing is conditional, retried, or
 * queued. The app decides when to save and what a person reviews.
 *
 * Methods close over the editor; none reads `this`, so destructuring them is
 * safe. One editor may serve several views; each view subscribes on its own.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileCapture, TextCapture } from '../../src/capture.js';
import type { CreateRowOf, FolderDefinition } from '../../src/contract.js';
import {
	type ApplyError,
	FileError,
	TableError,
	type TableReadError,
} from '../../src/errors.js';
import type { FolderFiles } from '../../src/files.js';
import { callObserver } from '../../src/observer.js';
import { rowAddressProblem, rowPath } from '../../src/paths.js';
import { type DeepReadonly, freezeDeep } from '../../src/reading.js';
import type { FileTable, TableReading } from '../../src/table.js';
import {
	type CanonicalDocument,
	type CanonicalRefusal,
	type CanonicalValue,
	formatCanonicalDocument,
	parseCanonicalDocument,
} from './canonical-codec.js';

/**
 * One exact version of the row: the bytes' hash and text, their document,
 * and that document's canonical text. A save receipt's `source` is its
 * `canonical`; a file another writer formatted differently is not.
 */
export type Revision = {
	readonly path: string;
	readonly sha256: string;
	/** The exact text of the bytes. */
	readonly source: string;
	readonly document: DeepReadonly<CanonicalDocument>;
	/** The text a save of `document` writes. Equal canonical text is equal content. */
	readonly canonical: string;
};

/**
 * What one read of the row found. Only `present` is a revision the editor
 * can follow or adopt: it has a canonical form and every declared field
 * conforms. The other kinds keep what is known for repair.
 */
export type Observation<TFields> =
	| { readonly kind: 'present'; readonly revision: Revision }
	| { readonly kind: 'missing' }
	| { readonly kind: 'unreadable'; readonly error: TableReadError }
	/** The text has no canonical form, such as a custom tag or an unsafe integer. */
	| {
			readonly kind: 'unsupported';
			readonly file: TextCapture;
			readonly refusal: CanonicalRefusal;
	  }
	/** The text does not parse as a row, or a declared field does not conform. */
	| {
			readonly kind: 'invalid';
			readonly file: TextCapture;
			readonly reading: TableReading<TFields>;
	  };

/**
 * Exactly what one save sent: the document and its canonical text. It is
 * not a revision: nothing says these bytes were published, so it has no
 * capture. A receipt adds the SHA-256 the folder returns; an unknown
 * outcome is compared with later reads by content, never by hash.
 */
export type SaveAttempt = {
	readonly path: string;
	readonly document: DeepReadonly<CanonicalDocument>;
	/** The canonical text sent, as UTF-8. */
	readonly source: string;
};

/**
 * How the latest settled save ended. History, never upgraded: an
 * `unconfirmed` attempt stays unknown even after a read finds its bytes.
 */
export type SaveOutcome =
	| { readonly kind: 'saved'; readonly receipt: Revision }
	| {
			readonly kind: 'unconfirmed';
			readonly attempt: SaveAttempt;
			readonly error: FileError;
	  }
	| {
			readonly kind: 'failed';
			readonly attempt: SaveAttempt;
			readonly error: FileError | ApplyError;
	  };

export type CanonicalEditorState<TFields> = {
	readonly path: string;
	readonly baseline: Revision;
	readonly document: DeepReadonly<CanonicalDocument>;
	/** The canonical text of `document`: exactly what `save()` writes. */
	readonly source: string;
	/** How `source` reads. Issues here make `save()` refuse; they never block `change`. */
	readonly reading: TableReading<TFields>;
	/** `source` differs from the baseline's canonical text. */
	readonly isDirty: boolean;
	/**
	 * The latest read that was applied. It may predate a save receipt until
	 * the reread that follows every save settles.
	 */
	readonly observation: Observation<TFields>;
	/**
	 * The admitted save, from admission until its reply: the document and
	 * text it captured when `save()` was called.
	 */
	readonly saving: SaveAttempt | undefined;
	readonly lastSave: SaveOutcome | undefined;
	readonly isDisposed: boolean;
};

export const CanonicalEditorError = defineErrors({
	/** The caller's signal aborted before the editor opened. Nothing stays subscribed. */
	Aborted: ({ path }: { path: string }) => ({
		message: `Opening '${path}' was aborted`,
		path,
	}),
	/** The file has no canonical form. `file` is the exact text, for repair. */
	UnsupportedSource: ({
		file,
		refusal,
	}: {
		file: TextCapture;
		refusal: CanonicalRefusal;
	}) => ({
		message: `'${file.path}' has no canonical form: ${refusal.reason}`,
		file,
		refusal,
	}),
	/** The file does not parse as a row or a declared field does not conform. */
	InvalidSource: ({
		file,
		reading,
	}: {
		file: TextCapture;
		reading: TableReading<unknown>;
	}) => ({
		message: `'${file.path}' is not a valid row: ${describeReading(reading)}`,
		file,
		reading,
	}),
	/** `save()` refused the local document; nothing was written. */
	InvalidDocument: ({
		path,
		reading,
	}: {
		path: string;
		reading: TableReading<unknown>;
	}) => ({
		message: `The document for '${path}' is not a valid row: ${describeReading(reading)}`,
		path,
		reading,
	}),
	/** A changed value has no canonical form. The document is unchanged. */
	Unrepresentable: ({
		path,
		refusal,
	}: {
		path: string;
		refusal: CanonicalRefusal;
	}) => ({
		message: `The change to '${path}' cannot be saved: ${refusal.reason}`,
		path,
		refusal,
	}),
	/** One save is admitted at a time; this call wrote nothing. */
	Saving: ({ path }: { path: string }) => ({
		message: `A save of '${path}' is already running`,
		path,
	}),
	/** The latest read's content is not the reviewed content. Review `latest` instead. */
	Stale: ({
		path,
		latest,
	}: {
		path: string;
		latest: Observation<unknown>;
	}) => ({
		message: `The reviewed content of '${path}' is no longer the latest read`,
		path,
		latest,
	}),
	Disposed: ({ path }: { path: string }) => ({
		message: `The editor for '${path}' is disposed`,
		path,
	}),
});
export type CanonicalEditorError = InferErrors<typeof CanonicalEditorError>;
type EditorErrorOf<TName extends CanonicalEditorError['name']> = Extract<
	CanonicalEditorError,
	{ name: TName }
>;

export type OpenError =
	| TableReadError
	| EditorErrorOf<'Aborted' | 'UnsupportedSource' | 'InvalidSource'>;
export type ChangeError = EditorErrorOf<'Unrepresentable' | 'Disposed'>;
export type SaveError =
	| EditorErrorOf<'InvalidDocument' | 'Saving' | 'Disposed'>
	| FileError
	| ApplyError;
export type AdoptError = EditorErrorOf<'Stale' | 'Saving' | 'Disposed'>;

/**
 * A change to the local document. Each named declared field is set, or
 * removed with `undefined`; fields not named stay as they are, unknown keys
 * included.
 *
 * Keys are the table's declared fields, so a misspelled or undeclared key
 * does not compile; editing unknown metadata is a raw repair through
 * `files.replace`, not a structured change. Values are any canonical value,
 * not the field's type: an intermediate value such as an empty title or an
 * unlisted option must be holdable while a person types. `reading` reports
 * whether it conforms. The runtime does not check keys, so untyped callers
 * can still name any key; the codec still refuses what has no canonical form.
 */
export type DocumentChange<TFields> = {
	readonly fields?: {
		readonly [K in keyof TFields & string]?: CanonicalValue | undefined;
	};
	readonly body?: string;
};

/**
 * The folder members an editor uses. A real `Folder` from any entry point
 * fits; so does a test double.
 */
export type CanonicalEditorFolder<TDefinition extends FolderDefinition> = {
	readonly tables: {
		readonly [K in keyof TDefinition['tables']]: Pick<
			FileTable<CreateRowOf<TDefinition['tables'][K]>>,
			'inspect'
		>;
	};
	readonly files: Pick<FolderFiles, 'read' | 'overwrite'>;
	onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
};

/**
 * Editors over a folder's table rows. `definition` supplies each table's
 * declared field order; the folder does not expose it.
 */
export function createCanonicalEditors<TDefinition extends FolderDefinition>(
	folder: CanonicalEditorFolder<TDefinition>,
	definition: TDefinition,
) {
	type Tables = TDefinition['tables'];
	const tables = Object.fromEntries(
		Object.keys(definition.tables).map((name) => {
			const declaredKeys = Object.freeze(
				Object.keys(definition.tables[name]?.fields ?? {}),
			);
			const inspect = (source: string) =>
				folder.tables[name]?.inspect(source) as TableReading<unknown>;
			return [
				name,
				{
					edit: (stem: string, options?: { signal?: AbortSignal }) =>
						openEditor(
							{ folder, name, declaredKeys, inspect },
							stem,
							options?.signal,
						),
				},
			];
		}),
	);
	return {
		tables: tables as {
			readonly [K in keyof Tables]: {
				/**
				 * Open an editor on the row at `stem`. It subscribes to change
				 * hints, then reads once. It opens only on a file that has a
				 * canonical form and whose declared fields conform; a refusal
				 * carries the exact text when there is one. `signal` governs
				 * opening only: once the editor is returned, `dispose` ends it.
				 */
				edit(
					stem: string,
					options?: { signal?: AbortSignal },
				): Promise<Result<CanonicalEditor<CreateRowOf<Tables[K]>>, OpenError>>;
			};
		},
	};
}

type RowTable = {
	readonly folder: Pick<
		CanonicalEditorFolder<FolderDefinition>,
		'files' | 'onFilesChanged'
	>;
	readonly name: string;
	readonly declaredKeys: readonly string[];
	inspect(source: string): TableReading<unknown>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Read the row once and classify what is there. Never throws. */
async function readRow(
	table: RowTable,
	path: string,
): Promise<Observation<unknown>> {
	let read: Awaited<ReturnType<FolderFiles['read']>>;
	try {
		read = await table.folder.files.read(path);
	} catch (cause) {
		return {
			kind: 'unreadable',
			error: FileError.Io({ path, operation: 'read', cause }).error,
		};
	}
	if (read.error) {
		if (read.error.name === 'NotFound') return { kind: 'missing' };
		return { kind: 'unreadable', error: read.error };
	}
	let source: string;
	try {
		source = utf8.decode(read.data.bytes);
	} catch {
		return {
			kind: 'unreadable',
			error: TableError.InvalidUtf8({ path }).error,
		};
	}
	const file: TextCapture = Object.freeze({
		path,
		sha256: read.data.sha256,
		source,
	});
	const parsed = parseCanonicalDocument(source);
	if (parsed.error) return { kind: 'unsupported', file, refusal: parsed.error };
	const canonical = formatCanonicalDocument(parsed.data, table.declaredKeys);
	if (canonical.error)
		return { kind: 'unsupported', file, refusal: canonical.error };
	const reading = table.inspect(source);
	if (reading.parseError !== undefined || reading.issues.length > 0)
		return { kind: 'invalid', file, reading };
	return {
		kind: 'present',
		revision: Object.freeze({
			...file,
			document: freezeDeep(parsed.data),
			canonical: canonical.data,
		}),
	};
}

async function openEditor(
	table: RowTable,
	stem: string,
	signal: AbortSignal | undefined,
): Promise<Result<CanonicalEditor<unknown>, OpenError>> {
	const problem = rowAddressProblem(table.name, stem);
	if (problem !== undefined)
		return FileError.InvalidPath({
			path: rowPath(table.name, String(stem)),
			reason: problem,
		});
	const path = rowPath(table.name, stem);
	if (signal?.aborted) return CanonicalEditorError.Aborted({ path });

	// Subscribe before the first read so no change falls between them. A hint
	// during opening is remembered and becomes a reread once the editor exists.
	let onHint = () => {
		hinted = true;
	};
	let hinted = false;
	const stopWatching = table.folder.onFilesChanged((paths) => {
		if (paths.includes(path)) onHint();
	});
	const aborted = Promise.withResolvers<'aborted'>();
	const onAbort = () => aborted.resolve('aborted');
	signal?.addEventListener('abort', onAbort, { once: true });
	let first: Observation<unknown> | 'aborted';
	try {
		first = await Promise.race([readRow(table, path), aborted.promise]);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
	if (first === 'aborted' || signal?.aborted) {
		stopWatching();
		return CanonicalEditorError.Aborted({ path });
	}
	switch (first.kind) {
		case 'present':
			break;
		case 'missing':
			stopWatching();
			return FileError.NotFound({ path });
		case 'unreadable':
			stopWatching();
			return Err(first.error);
		case 'unsupported':
			stopWatching();
			return CanonicalEditorError.UnsupportedSource(first);
		case 'invalid':
			stopWatching();
			return CanonicalEditorError.InvalidSource(first);
		default:
			first satisfies never;
	}
	const editor = createEditor(table, path, first, stopWatching);
	onHint = () => void editor.refresh();
	if (hinted) void editor.refresh();
	return Ok(editor);
}

function createEditor<TFields>(
	table: RowTable,
	path: string,
	first: Extract<Observation<TFields>, { kind: 'present' }>,
	stopWatching: () => void,
) {
	type State = CanonicalEditorState<TFields>;
	const inspect = (source: string) =>
		table.inspect(source) as TableReading<TFields>;
	const initial = first.revision;

	let state: State = Object.freeze({
		path,
		baseline: initial,
		document: initial.document,
		source: initial.canonical,
		reading: inspect(initial.canonical),
		isDirty: false,
		observation: first,
		saving: undefined,
		lastSave: undefined,
		isDisposed: false,
	});
	/** One `subscribe` call: its listener and the state it was last given. */
	type Subscription = {
		readonly listener: (state: State) => void;
		sent: State | undefined;
	};
	const subscriptions = new Set<Subscription>();
	let delivering = false;

	function update(patch: Partial<State>) {
		state = Object.freeze({ ...state, ...patch });
		deliver();
	}

	/**
	 * Give every subscription the current state it has not been given yet.
	 * Delivery is never reentrant: a listener that changes the state, or
	 * subscribes, is not called back inside itself; this loop calls it again
	 * afterward. So each subscription receives states in order, the current
	 * one last, and never the same state twice. What a listener throws is
	 * reported, never thrown into the operation that changed the state.
	 */
	function deliver() {
		if (delivering) return;
		delivering = true;
		try {
			let pending = true;
			while (pending) {
				pending = false;
				for (const subscription of [...subscriptions]) {
					if (!subscriptions.has(subscription)) continue;
					if (subscription.sent === state) continue;
					const sent = state;
					subscription.sent = sent;
					callObserver(
						'canonical editor subscriber',
						subscription.listener,
						sent,
					);
					pending = true;
				}
			}
		} finally {
			delivering = false;
			// Terminal delivery may add subscriptions; release them after it drains.
			if (state.isDisposed && admitted === undefined) subscriptions.clear();
		}
	}

	/** Make `revision` the baseline and the local document. */
	function follow(revision: Revision): Partial<State> {
		const same = revision.canonical === state.source;
		return {
			baseline: revision,
			document: same ? state.document : revision.document,
			source: revision.canonical,
			reading: same ? state.reading : inspect(revision.canonical),
			isDirty: false,
		};
	}

	/**
	 * Bumped when a save settles. A read that started before may describe
	 * the file before that write, so it is dropped and the read runs again.
	 */
	let epoch = 0;
	let rereadRequested = false;
	let readLoop: Promise<void> | undefined;

	/** Read now. Reads run one at a time and coalesce; this settles after a read that started after the call. */
	function refresh(): Promise<void> {
		if (state.isDisposed) return Promise.resolve();
		rereadRequested = true;
		readLoop ??= runReads();
		return readLoop;
	}

	async function runReads() {
		try {
			while (rereadRequested && !state.isDisposed) {
				rereadRequested = false;
				const startedIn = epoch;
				const observation = (await readRow(
					table,
					path,
				)) as Observation<TFields>;
				if (state.isDisposed) return;
				if (startedIn === epoch) observe(observation);
				else rereadRequested = true;
			}
		} finally {
			readLoop = undefined;
		}
	}

	/** Apply a read that is the latest knowledge of the file. */
	function observe(observation: Observation<TFields>) {
		const unchanged =
			observation.kind === state.observation.kind &&
			(observation.kind === 'missing' ||
				(observation.kind !== 'unreadable' &&
					shaOf(observation) === shaOf(state.observation)));
		// Adoption waits for the save's reply; the reread after it decides.
		if (state.saving !== undefined || observation.kind !== 'present') {
			if (!unchanged) update({ observation });
			return;
		}
		const { revision } = observation;
		if (revision.sha256 === state.baseline.sha256) {
			if (!unchanged) update({ observation });
			return;
		}
		// A clean editor follows the file. A dirty one keeps its input; when
		// the file already holds that content, it is no longer unsaved. That
		// is a content fact: it does not say which writer put it there, so an
		// unconfirmed `lastSave` stays unconfirmed.
		if (!state.isDirty || revision.canonical === state.source) {
			update({ ...follow(revision), observation });
			return;
		}
		if (!unchanged) update({ observation });
	}

	/** Replace the local document. It may become schema invalid; it must stay representable. */
	function change(
		requested: DocumentChange<TFields>,
	): Result<undefined, ChangeError> {
		if (state.isDisposed) return CanonicalEditorError.Disposed({ path });
		const fields: Record<string, unknown> = { ...state.document.fields };
		const named: { readonly [key: string]: CanonicalValue | undefined } =
			requested.fields ?? {};
		for (const [key, value] of Object.entries(named)) {
			if (value === undefined) delete fields[key];
			else
				Object.defineProperty(fields, key, {
					value,
					enumerable: true,
					writable: true,
					configurable: true,
				});
		}
		const draft = {
			fields: fields as CanonicalDocument['fields'],
			body: requested.body ?? state.document.body,
		};
		const formatted = formatCanonicalDocument(draft, table.declaredKeys);
		if (formatted.error)
			return CanonicalEditorError.Unrepresentable({
				path,
				refusal: formatted.error,
			});
		if (formatted.data === state.source) return Ok(undefined);
		// Reading the canonical text back gives the editor its own frozen copy,
		// exactly the document a save writes.
		const owned = parseCanonicalDocument(formatted.data);
		if (owned.error)
			return CanonicalEditorError.Unrepresentable({
				path,
				refusal: owned.error,
			});
		update({
			document: freezeDeep(owned.data),
			source: formatted.data,
			reading: inspect(formatted.data),
			isDirty: formatted.data !== state.baseline.canonical,
		});
		return Ok(undefined);
	}

	/**
	 * The admitted save, from admission until its reply is applied. It is set
	 * before any listener hears `saving` and cleared before any listener hears
	 * the outcome, so a listener that disposes, or starts the next save, finds
	 * the right one.
	 */
	let admitted:
		| { readonly completion: Promise<Result<Revision, SaveError>> }
		| undefined;

	/**
	 * Write the complete local document once, whatever the file holds. The
	 * document is captured now: input after this call stays local and stays
	 * dirty against the receipt. The receipt describes the submitted bytes,
	 * not a later read.
	 */
	function save(): Promise<Result<Revision, SaveError>> {
		if (state.isDisposed)
			return Promise.resolve(CanonicalEditorError.Disposed({ path }));
		if (admitted !== undefined)
			return Promise.resolve(CanonicalEditorError.Saving({ path }));
		const { reading } = state;
		if (reading.parseError !== undefined || reading.issues.length > 0)
			return Promise.resolve(
				CanonicalEditorError.InvalidDocument({ path, reading }),
			);
		const attempt: SaveAttempt = Object.freeze({
			path,
			document: state.document,
			source: state.source,
		});
		// Admission is synchronous and recorded before anyone hears of it: a
		// second call, a disposal, and later input all see it at once.
		const completion = Promise.withResolvers<Result<Revision, SaveError>>();
		const admission = { completion: completion.promise };
		admitted = admission;
		update({ saving: attempt });
		submit(admission, attempt).then(completion.resolve, completion.reject);
		return completion.promise;
	}

	/** Release the admission before anyone hears the outcome, and only if it is still this one. */
	function release(admission: NonNullable<typeof admitted>) {
		epoch += 1;
		if (admitted === admission) admitted = undefined;
	}

	async function submit(
		admission: NonNullable<typeof admitted>,
		attempt: SaveAttempt,
	): Promise<Result<Revision, SaveError>> {
		let result: Result<FileCapture, FileError | ApplyError>;
		try {
			// The folder encodes the text as UTF-8 and returns the capture of
			// exactly those bytes; nothing here hashes them again.
			result = await table.folder.files.overwrite(path, attempt.source);
		} catch (thrown) {
			// The port reports failure as a Result, so a throw is a bug, not an
			// outcome: it is not recorded as `unconfirmed`. The editor still
			// releases the save, and the throw reaches `save()` and `dispose()`.
			release(admission);
			update({ saving: undefined });
			void refresh();
			throw thrown;
		}
		release(admission);
		let outcome: SaveOutcome;
		if (result.error === null) {
			const receipt: Revision = Object.freeze({
				...attempt,
				sha256: result.data.sha256,
				canonical: attempt.source,
			});
			outcome = Object.freeze({ kind: 'saved', receipt });
			update({
				baseline: receipt,
				isDirty: state.source !== receipt.canonical,
				saving: undefined,
				lastSave: outcome,
			});
		} else {
			const { error } = result;
			outcome = Object.freeze(
				error.name === 'Unconfirmed'
					? { kind: 'unconfirmed', attempt, error }
					: { kind: 'failed', attempt, error },
			);
			update({ saving: undefined, lastSave: outcome });
		}
		// Every settlement is followed by a read against the new baseline.
		void refresh();
		return outcome.kind === 'saved' ? Ok(outcome.receipt) : Err(outcome.error);
	}

	/**
	 * Take the file's current content in place of local input, after a
	 * person reviewed it. Accepted only while the latest valid read has the
	 * reviewed canonical content: another tool may have changed its comments
	 * or quoting since, but not its content. The editor then follows its own
	 * latest revision. Only `path` and `canonical` are read from `reviewed`,
	 * so a supplied document, source, or hash never enters the editor. This
	 * chooses the reviewed current content; it never restores history.
	 */
	function adopt(
		reviewed: Pick<Revision, 'path' | 'canonical'>,
	): Result<undefined, AdoptError> {
		if (state.isDisposed) return CanonicalEditorError.Disposed({ path });
		if (admitted !== undefined) return CanonicalEditorError.Saving({ path });
		const latest = state.observation;
		if (
			latest.kind !== 'present' ||
			reviewed.path !== path ||
			reviewed.canonical !== latest.revision.canonical
		)
			return CanonicalEditorError.Stale({ path, latest });
		update(follow(latest.revision));
		return Ok(undefined);
	}

	let disposal: Promise<void> | undefined;

	return {
		/** The current state. The same frozen object until the next change. */
		get: () => state,
		/**
		 * Give `listener` the current state, then notify it when state changes. Called from
		 * outside a notification, it is called before this returns; called
		 * from inside one, it is called after the running listener returns.
		 * Reentrant changes may coalesce intermediate states; delivery always
		 * ends with the current state. Each call is its own subscription, and
		 * the returned function stops
		 * only that one. Disposal retains listeners until an admitted save
		 * settles, then releases them. A terminal editor delivers its current
		 * snapshot to a new subscriber once and retains no listener.
		 */
		subscribe(listener: (state: State) => void): () => void {
			const subscription: Subscription = { listener, sent: undefined };
			subscriptions.add(subscription);
			deliver();
			return () => {
				subscriptions.delete(subscription);
			};
		},
		change,
		save,
		refresh,
		adopt,
		/**
		 * Stop watching and refuse new input, reads, saves, and adoptions. An
		 * admitted save still settles into `lastSave`; the promise settles
		 * after it, and rejects with the same error if the save threw.
		 * Calling again returns the same promise.
		 */
		dispose(): Promise<void> {
			if (disposal !== undefined) return disposal;
			// Fixed before anyone hears `isDisposed`, so a listener that
			// disposes again gets this same promise.
			disposal =
				admitted?.completion.then(() => undefined) ?? Promise.resolve();
			stopWatching();
			update({ isDisposed: true });
			return disposal;
		},
	};
}

export type CanonicalEditor<TFields> = ReturnType<typeof createEditor<TFields>>;

function shaOf(observation: Observation<unknown>): string | undefined {
	switch (observation.kind) {
		case 'present':
			return observation.revision.sha256;
		case 'unsupported':
		case 'invalid':
			return observation.file.sha256;
		default:
			return undefined;
	}
}

function describeReading(reading: TableReading<unknown>): string {
	if (reading.parseError !== undefined) return reading.parseError.message;
	return reading.issues.map((issue) => issue.message).join('; ');
}
