/**
 * Row editors: one retained, canonical draft of one table row.
 *
 *     const { data: editor, error } = await folder.tables.todos.edit(stem, { signal });
 *     if (error !== null) return showOpenError(error);
 *     const { get, subscribe, change, save, refresh, adopt, dispose } = editor;
 *
 * The table that owns the row supplies its path, schema, and declared field
 * order, so an editor is opened only through `table.edit`. The editor keeps
 * three values apart:
 *
 * - `baseline`: the revision `isDirty` compares against. It moves when a
 *   clean editor follows a valid read, when a read matches the local
 *   document, on a save receipt, and on `adopt`.
 * - `document`: the local fields and body. Changes may make it schema
 *   invalid; a read never resets dirty input.
 * - `observation`: what the latest read found, present or not. The editor
 *   never invents one.
 *
 * Dirty is semantic: the local document's canonical text differs from the
 * baseline's. External change is exact: a read's SHA-256 differs from the
 * baseline's. A save always overwrites the row's path with the complete
 * canonical document; nothing is conditional, retried, or queued. Change
 * hints are advisory: each one for the row's path requests a reread. The
 * application decides when to save and what a person reviews. Editing what
 * the editor refuses, such as unknown metadata or text with no canonical
 * form, is a raw repair through `files.overwrite` or `table.replace`.
 *
 * Methods close over the editor; none reads `this`, so destructuring them is
 * safe. One editor may serve several views; each view subscribes on its own.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage, Submission } from './boundary.js';
import {
	type CanonicalDocument,
	type CanonicalRefusal,
	type CanonicalValue,
	defineOwn,
	formatCanonicalDocument,
	parseCanonicalDocument,
} from './canonical.js';
import { hashBytes, ownBytes, type TextCapture } from './capture.js';
import { FileError, TableError, type TableReadError } from './errors.js';
import { callObserver } from './observer.js';
import { type DeepReadonly, freezeDeep } from './reading.js';
import type { TableReading } from './row-text.js';
import { applyOne, reserveSubmission } from './storage.js';

/**
 * One exact version of the row: the bytes' hash and text, their document,
 * and that document's canonical text. A save receipt's `text` is its
 * `canonical`; a file another writer formatted differently is not.
 */
export type RowRevision = {
	readonly path: string;
	readonly sha256: string;
	/** The exact text of the whole file's bytes. */
	readonly text: string;
	readonly document: DeepReadonly<CanonicalDocument>;
	/** The text a save of `document` writes. Equal canonical text is equal content. */
	readonly canonical: string;
};

/**
 * What one read of the row found. Only `present` is a revision the editor
 * can follow or adopt: it has a canonical form and every declared field
 * conforms. The other kinds keep what is known for repair.
 */
export type RowObservation<TFields> =
	| { readonly kind: 'present'; readonly revision: RowRevision }
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
 * hash. A receipt adds the SHA-256 of the bytes storage accepted; an unknown
 * outcome is compared with later reads by content, never by hash.
 */
export type RowSaveAttempt = {
	readonly path: string;
	readonly document: DeepReadonly<CanonicalDocument>;
	/** The canonical text sent, as UTF-8. */
	readonly text: string;
};

/**
 * How the latest settled save ended. History, never upgraded: an
 * `unconfirmed` attempt stays unknown even after a read finds its bytes.
 */
export type RowSaveOutcome =
	| { readonly kind: 'saved'; readonly receipt: RowRevision }
	| {
			readonly kind: 'unconfirmed';
			readonly attempt: RowSaveAttempt;
			readonly error: FileError;
	  }
	| {
			readonly kind: 'failed';
			readonly attempt: RowSaveAttempt;
			readonly error: FileError;
	  };

export type RowEditorState<TFields> = {
	readonly path: string;
	readonly baseline: RowRevision;
	readonly document: DeepReadonly<CanonicalDocument>;
	/** The canonical text of `document`: exactly what `save()` writes. */
	readonly text: string;
	/** How `text` reads. Issues here make `save()` refuse; they never block `change`. */
	readonly reading: TableReading<TFields>;
	/** `text` differs from the baseline's canonical text. */
	readonly isDirty: boolean;
	/**
	 * The latest read that was applied. It may predate a save receipt until
	 * the reread that follows every save settles.
	 */
	readonly observation: RowObservation<TFields>;
	/**
	 * The admitted save, from admission until its reply: the document and
	 * text it captured when `save()` was called.
	 */
	readonly saving: RowSaveAttempt | undefined;
	readonly lastSave: RowSaveOutcome | undefined;
	readonly isDisposed: boolean;
};

export const RowEditorError = defineErrors({
	/** The caller's signal aborted before the editor opened. Nothing stays subscribed. */
	Aborted: ({ path }: { path: string }) => ({
		message: `Opening '${path}' was aborted`,
		path,
	}),
	/** The file has no canonical form. `file` is the exact text, for repair. */
	NoCanonicalForm: ({
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
		latest: RowObservation<unknown>;
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
export type RowEditorError = InferErrors<typeof RowEditorError>;
type RowEditorErrorOf<TName extends RowEditorError['name']> = Extract<
	RowEditorError,
	{ name: TName }
>;

/**
 * Why `table.edit` opened no editor. An address the folder does not admit
 * is `InvalidPath` and an absent row is `NotFound`, both from `FileError`.
 */
export type TableEditError =
	| TableReadError
	| RowEditorErrorOf<'Aborted' | 'NoCanonicalForm' | 'InvalidSource'>;
export type RowChangeError = RowEditorErrorOf<'Unrepresentable' | 'Disposed'>;
export type RowSaveError =
	| RowEditorErrorOf<'InvalidDocument' | 'Saving' | 'Disposed'>
	| FileError;
export type RowAdoptError = RowEditorErrorOf<'Stale' | 'Saving' | 'Disposed'>;

/**
 * A change to the local document. Each named declared field is set, or
 * removed with `undefined`; fields not named stay as they are, unknown keys
 * included.
 *
 * Keys are the table's declared fields, so a misspelled or undeclared key
 * does not compile; editing unknown metadata is a raw repair, not a
 * structured change. Values are any canonical value, not the field's type:
 * an intermediate value such as an empty title or an unlisted option must be
 * holdable while a person types. `reading` reports whether it conforms. The
 * runtime does not check keys, so untyped callers can still name any key; the
 * codec still refuses what has no canonical form.
 */
export type RowChange<TFields> = {
	readonly fields?: {
		readonly [K in keyof TFields & string]?: CanonicalValue | undefined;
	};
	readonly body?: string;
};

/** What the table that owns a row gives the row's editor. */
type EditedRow<TFields> = {
	readonly path: string;
	readonly storage: Pick<FolderStorage, 'read' | 'apply'>;
	onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
	/** The table's declared field names, in declared order. */
	readonly declaredKeys: readonly string[];
	inspect(text: string): TableReading<TFields>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Read the row once and classify what is there. Never throws. */
async function readRow<TFields>(
	row: EditedRow<TFields>,
): Promise<RowObservation<TFields>> {
	const { path } = row;
	let read: Awaited<ReturnType<FolderStorage['read']>>;
	try {
		read = await row.storage.read(path);
	} catch (cause) {
		// A read runs from a change hint with nobody awaiting it, so even a
		// storage bug is kept as an observation instead of escaping.
		return Object.freeze({
			kind: 'unreadable',
			error: FileError.Io({ path, operation: 'read', cause }).error,
		});
	}
	const { data: current, error: readError } = read;
	if (readError !== null) {
		if (readError.name === 'NotFound')
			return Object.freeze({ kind: 'missing' });
		return Object.freeze({ kind: 'unreadable', error: readError });
	}
	let text: string;
	try {
		text = utf8.decode(current.bytes);
	} catch {
		return Object.freeze({
			kind: 'unreadable',
			error: TableError.InvalidUtf8({ path, sha256: current.sha256 }).error,
		});
	}
	const file: TextCapture = Object.freeze({
		path,
		sha256: current.sha256,
		text,
	});
	const { data: parsed, error: parseRefusal } = parseCanonicalDocument(text);
	if (parseRefusal !== null)
		return Object.freeze({ kind: 'unsupported', file, refusal: parseRefusal });
	const { data: canonical, error: formatRefusal } = formatCanonicalDocument(
		parsed,
		row.declaredKeys,
	);
	if (formatRefusal !== null)
		return Object.freeze({
			kind: 'unsupported',
			file,
			refusal: formatRefusal,
		});
	const reading = row.inspect(text);
	if (reading.parseError !== undefined || reading.issues.length > 0)
		return Object.freeze({ kind: 'invalid', file, reading });
	return Object.freeze({
		kind: 'present',
		revision: Object.freeze({
			...file,
			document: freezeDeep(parsed),
			canonical,
		}),
	});
}

/**
 * Open an editor on a row: subscribe to change hints, then read once. Only
 * a file with a canonical form whose declared fields conform opens; a
 * refusal carries the exact text when there is one. `signal` governs opening
 * only: once the editor is returned, its `dispose` ends it.
 */
export async function openRowEditor<TFields>(
	row: EditedRow<TFields>,
	signal: AbortSignal | undefined,
): Promise<Result<RowEditor<TFields>, TableEditError>> {
	const { path } = row;
	if (signal?.aborted) return RowEditorError.Aborted({ path });

	// Subscribe before the first read so no change falls between them. A hint
	// during opening is remembered and becomes a reread once the editor exists.
	let hinted = false;
	let onHint = () => {
		hinted = true;
	};
	const stopWatching = row.onFilesChanged((paths) => {
		if (paths.includes(path)) onHint();
	});
	const aborted = Promise.withResolvers<'aborted'>();
	const onAbort = () => aborted.resolve('aborted');
	signal?.addEventListener('abort', onAbort, { once: true });
	let first: RowObservation<TFields> | 'aborted';
	try {
		first = await Promise.race([readRow(row), aborted.promise]);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
	if (first === 'aborted' || signal?.aborted) {
		stopWatching();
		return RowEditorError.Aborted({ path });
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
			return RowEditorError.NoCanonicalForm(first);
		case 'invalid':
			stopWatching();
			return RowEditorError.InvalidSource(first);
		default:
			first satisfies never;
	}
	const editor = createRowEditor(row, first, stopWatching);
	onHint = () => void editor.refresh();
	if (hinted) void editor.refresh();
	return Ok(editor);
}

function createRowEditor<TFields>(
	row: EditedRow<TFields>,
	first: Extract<RowObservation<TFields>, { kind: 'present' }>,
	stopWatching: () => void,
) {
	type State = RowEditorState<TFields>;
	const { path } = row;
	const initial = first.revision;

	let state: State = Object.freeze({
		path,
		baseline: initial,
		document: initial.document,
		text: initial.canonical,
		reading: row.inspect(initial.canonical),
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
					callObserver('row editor subscriber', subscription.listener, sent);
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
	function follow(revision: RowRevision): Partial<State> {
		const same = revision.canonical === state.text;
		return {
			baseline: revision,
			document: same ? state.document : revision.document,
			text: revision.canonical,
			reading: same ? state.reading : row.inspect(revision.canonical),
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
				const observation = await readRow(row);
				if (state.isDisposed) return;
				if (startedIn === epoch) observe(observation);
				else rereadRequested = true;
			}
		} finally {
			readLoop = undefined;
		}
	}

	/** Apply a read that is the latest knowledge of the file. */
	function observe(observation: RowObservation<TFields>) {
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
		if (!state.isDirty || revision.canonical === state.text) {
			update({ ...follow(revision), observation });
			return;
		}
		if (!unchanged) update({ observation });
	}

	function change(
		requested: RowChange<TFields>,
	): Result<undefined, RowChangeError> {
		if (state.isDisposed) return RowEditorError.Disposed({ path });
		const fields: Record<string, unknown> = { ...state.document.fields };
		const named: { readonly [key: string]: CanonicalValue | undefined } =
			requested.fields ?? {};
		for (const [key, value] of Object.entries(named)) {
			if (value === undefined) delete fields[key];
			else defineOwn(fields, key, value);
		}
		const draft = {
			fields: fields as CanonicalDocument['fields'],
			body: requested.body ?? state.document.body,
		};
		const { data: formatted, error: formatRefusal } = formatCanonicalDocument(
			draft,
			row.declaredKeys,
		);
		if (formatRefusal !== null)
			return RowEditorError.Unrepresentable({ path, refusal: formatRefusal });
		if (formatted === state.text) return Ok(undefined);
		// Reading the canonical text back gives the editor its own frozen copy,
		// exactly the document a save writes.
		const { data: owned, error: parseRefusal } =
			parseCanonicalDocument(formatted);
		if (parseRefusal !== null)
			return RowEditorError.Unrepresentable({ path, refusal: parseRefusal });
		update({
			document: freezeDeep(owned),
			text: formatted,
			reading: row.inspect(formatted),
			isDirty: formatted !== state.baseline.canonical,
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
		| { readonly completion: Promise<Result<RowRevision, RowSaveError>> }
		| undefined;

	function save(): Promise<Result<RowRevision, RowSaveError>> {
		if (state.isDisposed)
			return Promise.resolve(RowEditorError.Disposed({ path }));
		if (admitted !== undefined)
			return Promise.resolve(RowEditorError.Saving({ path }));
		const { reading } = state;
		if (reading.parseError !== undefined || reading.issues.length > 0)
			return Promise.resolve(RowEditorError.InvalidDocument({ path, reading }));
		const attempt: RowSaveAttempt = Object.freeze({
			path,
			document: state.document,
			text: state.text,
		});
		// Admission is synchronous and recorded before anyone hears of it: a
		// second call, a disposal, and later input all see it at once. Its place
		// among the page's saves is taken here too, so a save a listener starts
		// on hearing `saving` comes after this one.
		const submission = reserveSubmission();
		const completion =
			Promise.withResolvers<Result<RowRevision, RowSaveError>>();
		const admission = { completion: completion.promise };
		admitted = admission;
		update({ saving: attempt });
		submit(admission, attempt, submission).then(
			completion.resolve,
			completion.reject,
		);
		return completion.promise;
	}

	/** Release the admission before anyone hears the outcome, and only if it is still this one. */
	function release(admission: NonNullable<typeof admitted>) {
		epoch += 1;
		if (admitted === admission) admitted = undefined;
	}

	async function submit(
		admission: NonNullable<typeof admitted>,
		attempt: RowSaveAttempt,
		submission: Submission,
	): Promise<Result<RowRevision, RowSaveError>> {
		let sha256: string;
		let applied: Result<undefined, FileError>;
		try {
			// Canonical text is well formed, so these bytes decode back to it.
			const bytes = ownBytes(attempt.text);
			sha256 = await hashBytes(bytes);
			applied = await applyOne(
				row.storage,
				{ kind: 'overwrite', path, bytes, sha256 },
				submission,
			);
		} catch (thrown) {
			// Storage reports failure as a Result, so a throw is a bug, not an
			// outcome: it is not recorded as `unconfirmed`. The editor still
			// releases the save, and the throw reaches `save()` and `dispose()`.
			release(admission);
			update({ saving: undefined });
			void refresh();
			throw thrown;
		}
		release(admission);
		let outcome: RowSaveOutcome;
		const { error: applyError } = applied;
		if (applyError === null) {
			const receipt: RowRevision = Object.freeze({
				...attempt,
				sha256,
				canonical: attempt.text,
			});
			outcome = Object.freeze({ kind: 'saved', receipt });
			update({
				baseline: receipt,
				isDirty: state.text !== receipt.canonical,
				saving: undefined,
				lastSave: outcome,
			});
		} else {
			outcome = Object.freeze(
				applyError.name === 'Unconfirmed'
					? { kind: 'unconfirmed', attempt, error: applyError }
					: { kind: 'failed', attempt, error: applyError },
			);
			update({ saving: undefined, lastSave: outcome });
		}
		// Every settlement is followed by a read against the new baseline.
		void refresh();
		return outcome.kind === 'saved' ? Ok(outcome.receipt) : Err(outcome.error);
	}

	function adopt(
		reviewed: Pick<RowRevision, 'path' | 'canonical'>,
	): Result<undefined, RowAdoptError> {
		if (state.isDisposed) return RowEditorError.Disposed({ path });
		if (admitted !== undefined) return RowEditorError.Saving({ path });
		const latest = state.observation;
		if (
			latest.kind !== 'present' ||
			reviewed.path !== path ||
			reviewed.canonical !== latest.revision.canonical
		)
			return RowEditorError.Stale({ path, latest });
		update(follow(latest.revision));
		return Ok(undefined);
	}

	let disposal: Promise<void> | undefined;

	return Object.freeze({
		/** The current state. The same frozen object until the next change. */
		get: (): State => state,
		/**
		 * Give `listener` the current state, then notify it when state changes.
		 * Called from outside a notification, it is called before this returns;
		 * called from inside one, it is called after the running listener
		 * returns. Reentrant changes may coalesce intermediate states; delivery
		 * always ends with the current state. Each call is its own
		 * subscription, and the returned function stops only that one. What a
		 * listener throws is logged and reaches no operation or other listener.
		 * Disposal retains listeners until an admitted save settles, then
		 * releases them. A terminal editor delivers its current snapshot to a
		 * new subscriber once and retains no listener.
		 */
		subscribe(listener: (state: State) => void): () => void {
			const subscription: Subscription = { listener, sent: undefined };
			subscriptions.add(subscription);
			deliver();
			return () => {
				subscriptions.delete(subscription);
			};
		},
		/**
		 * Replace the local document. It may become schema invalid; `reading`
		 * says how, and `save()` refuses it. A value with no canonical form,
		 * such as `NaN`, is refused and the document is unchanged.
		 */
		change,
		/**
		 * Write the complete local document once, whatever the file holds, even
		 * when it is clean. The document is captured now: input after this call
		 * stays local and stays dirty against the receipt. The receipt describes
		 * the submitted bytes, not a later read. `Unconfirmed` stays in
		 * `lastSave` as unknown; nothing retries.
		 */
		save,
		/** Read now. Reads run one at a time and coalesce; this settles after a read that started after the call. */
		refresh,
		/**
		 * Take the file's current content in place of local input, after a
		 * person reviewed it. Accepted only while the latest valid read has the
		 * reviewed canonical content: another tool may have changed its
		 * comments or quoting since, but not its content. The editor then
		 * follows its own latest revision. Only `path` and `canonical` are read
		 * from `reviewed`, so a supplied document, text, or hash never enters
		 * the editor. This chooses the reviewed current content; it never
		 * restores history.
		 */
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
	});
}

export type RowEditor<TFields> = ReturnType<typeof createRowEditor<TFields>>;

function shaOf(observation: RowObservation<unknown>): string | undefined {
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
