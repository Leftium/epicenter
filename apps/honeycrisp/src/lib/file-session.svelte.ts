/**
 * One open file's editing session, and the only place Honeycrisp asks the
 * folder to change a file.
 *
 * A session keeps these facts apart:
 *
 * - `saved` is the capture this session last agreed is in the file: its path,
 *   the sha256 of its bytes, and the text those bytes are. It is the
 *   baseline the next replace, move, or remove is conditional on.
 * - `buffer` is the text on screen, including unsaved typing. The rich-text
 *   view, the Source view, and the metadata controls all edit this one string.
 * - `attempt` is exactly what a write submitted: the path, the text, and the
 *   condition. It is `sent` until the folder replies, and `unconfirmed` when
 *   the reply cannot say whether the write happened. Its text is the text of
 *   the bytes that were sent, which differs from the typed string only where
 *   encoding replaced an unpaired surrogate, so it is what a read of those
 *   bytes returns.
 * - `pathChange` is a move or a removal of this file that was submitted: the
 *   capture it named and, for a move, the destination. It is kept when its
 *   outcome is unknown or partial.
 * - `external` is what an observation found on disk that this session has not
 *   agreed with. Each observation of new bytes is a new object, so a review
 *   names one by identity and a later observation cannot change its target.
 *
 * What a reply or an observation may conclude:
 *
 * - A successful write acknowledges the submitted text at the capture the
 *   folder returned. Nothing is read to confirm it, and typing during the
 *   write stays dirty. A buffer that is the same bytes as the saved text
 *   shows the saved text, so it is not dirty and is not sent again.
 * - A refusal wrote nothing. `saved` and `external` are left as they are until
 *   a read says otherwise.
 * - An unconfirmed write stays exactly as it was sent, and nothing more is
 *   saved while it does. Retrying submits that same path, text, and condition
 *   again; newer typing is never sent in its place. The old file, no file, an
 *   unreadable file, or other text does not end it: none shows the command
 *   cannot still land. Other text is recorded beside it as `external`.
 * - Reading exactly the attempted text at the attempted path does end it:
 *   that text is what the file holds, so it becomes `saved`. This says
 *   nothing about which command wrote it or whether the first one arrived.
 *   Newer typing is then dirty against that capture. A read alone never
 *   starts the next save.
 * - A move or removal whose outcome is unknown or partial is kept. Nothing is
 *   saved, moved, or concluded from a read while it stands, and the session
 *   is not forgotten. There is no retry and no cleanup: nothing here can show
 *   which file the session should go on with.
 *
 * Every write is conditional on a capture, so a command that lands late is
 * refused by its own condition or shows up as a change to review. The
 * condition is the folder's: on a real directory it compares the bytes it
 * reads just before replacing them, which another program can still race.
 */
import {
	type ApplyError,
	type FileCapture,
	type FileError,
	type FolderFiles,
} from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import { type Capture, readTextFile, submittedText } from './files.js';

// ============================================================================
// The folder calls
// ============================================================================

/** What the folder said about one requested change. */
export type FileOutcome<T = undefined> =
	| { readonly kind: 'done'; readonly value: T }
	| {
			/** The condition did not hold, and nothing was written. */
			readonly kind: 'refused';
			readonly message: string;
			/** The path that already holds a file, when the condition was absence. */
			readonly occupied: string | undefined;
	  }
	| {
			/**
			 * `failed` changed nothing. `partial` changed part of what was asked.
			 * `unconfirmed` may or may not have changed anything.
			 */
			readonly kind: 'failed' | 'partial' | 'unconfirmed';
			/** The library's name for the error. */
			readonly name: string;
			readonly message: string;
	  };

/** Read the folder's reply. Every changing call in this module goes through here. */
async function ask<T>(
	call: () => Promise<Result<T, FileError | ApplyError>>,
): Promise<FileOutcome<T>> {
	let result: Result<T, FileError | ApplyError>;
	try {
		result = await call();
	} catch (cause) {
		// A call that threw never said whether it wrote.
		return {
			kind: 'unconfirmed',
			name: 'Thrown',
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
	if (result.error === null) return { kind: 'done', value: result.data };
	const { error } = result;
	if (error.name === 'Conflict' || error.name === 'Exists')
		return {
			kind: 'refused',
			message: error.message,
			occupied: error.name === 'Exists' ? error.path : undefined,
		};
	return {
		kind:
			error.name === 'Unconfirmed'
				? 'unconfirmed'
				: error.name === 'Partial'
					? 'partial'
					: 'failed',
		name: error.name,
		message: error.message,
	};
}

/**
 * Save `text` as a file that must not exist yet. The capture's source is the
 * text of the bytes that were sent.
 */
export async function createFile(
	files: Pick<FolderFiles, 'create'>,
	path: string,
	text: string,
): Promise<FileOutcome<Capture>> {
	const { bytes, source } = submittedText(text);
	const created = await ask(() => files.create(path, bytes));
	return created.kind === 'done'
		? { kind: 'done', value: { ...created.value, source } }
		: created;
}

/**
 * Save `text` over a file only while it still holds the captured bytes. The
 * capture's source is the text of the bytes that were sent.
 */
export async function replaceFile(
	files: Pick<FolderFiles, 'replace'>,
	base: FileCapture,
	text: string,
): Promise<FileOutcome<Capture>> {
	const { bytes, source } = submittedText(text);
	const replaced = await ask(() => files.replace(base, bytes));
	return replaced.kind === 'done'
		? { kind: 'done', value: { ...replaced.value, source } }
		: replaced;
}

/**
 * Move the captured bytes to a path that must not exist yet. A `partial`
 * outcome means the destination was created and the original is still there.
 */
export function moveFile(
	files: Pick<FolderFiles, 'move'>,
	file: FileCapture,
	to: string,
): Promise<FileOutcome<FileCapture>> {
	return ask(() => files.move(file, to));
}

/** Remove a file only while it still holds the captured bytes. */
export function removeFile(
	files: Pick<FolderFiles, 'remove'>,
	file: FileCapture,
): Promise<FileOutcome> {
	return ask(() => files.remove(file));
}

/** Make a directory. A reply that never comes is `unconfirmed`, as for a file. */
export function makeDirectory(
	files: Pick<FolderFiles, 'mkdir'>,
	path: string,
): Promise<FileOutcome> {
	return ask(() => files.mkdir(path));
}

/** Remove an empty directory. */
export function removeDirectory(
	files: Pick<FolderFiles, 'rmdir'>,
	path: string,
): Promise<FileOutcome> {
	return ask(() => files.rmdir(path));
}

// ============================================================================
// The session
// ============================================================================

/** What a fresh read of the path found. */
export type Observed =
	| { readonly kind: 'present'; readonly file: Capture }
	| { readonly kind: 'removed' }
	| { readonly kind: 'unreadable'; readonly message: string };

/** What is on disk that the session has not agreed with. */
export type External =
	| { readonly kind: 'changed'; readonly current: Capture }
	| { readonly kind: 'removed' }
	| { readonly kind: 'unreadable'; readonly message: string };

/**
 * One submitted write: where, what text, and on what condition. `source` is
 * the text of the bytes sent, so it encodes to exactly those bytes again.
 */
type Submission = { readonly path: string; readonly source: string } & (
	| { readonly kind: 'create' }
	| { readonly kind: 'replace'; readonly expectedSha256: string }
);

export type Attempt = Submission &
	(
		| { readonly state: 'sent' }
		| {
				/** The folder could not say whether this write happened. */
				readonly state: 'unconfirmed';
				readonly problem: string;
		  }
	);

/** One submitted move or removal of this session's file. */
type PathStep =
	| {
			readonly kind: 'move';
			readonly from: FileCapture;
			readonly to: string;
	  }
	| { readonly kind: 'remove'; readonly from: FileCapture };

export type PathChange = PathStep &
	(
		| { readonly state: 'sent' }
		| {
				/**
				 * `unconfirmed`: it may or may not have happened. `partial`: a
				 * move created the destination and did not remove the original.
				 */
				readonly state: 'unconfirmed' | 'partial';
				readonly problem: string;
		  }
	);

export type SessionStatus =
	| 'saved'
	| 'dirty'
	| 'saving'
	| 'failed'
	| 'conflict'
	/** A write, move, or removal whose outcome is not known, or a partial move. */
	| 'unconfirmed';

/** What an observation did to the session. */
export type ObserveOutcome =
	| 'same'
	| 'adopted'
	| 'conflict'
	/** The text of an unconfirmed attempt is in the file: it is the saved text now. */
	| 'reconciled'
	/** The file is gone and nothing was held; the owner may forget the session. */
	| 'gone'
	/** A write, move, or removal is running; the path is read again when it settles. */
	| 'deferred';

/** Typing batches for this long before a save. */
const TYPING_BATCH_MS = 500;

export type FileSession = ReturnType<typeof createFileSession>;

export function createFileSession(
	files: Pick<FolderFiles, 'read' | 'create' | 'replace' | 'move' | 'remove'>,
	initial: Capture,
	{
		onSaved = () => {},
		admits = () => true,
	}: {
		/** After this session's saved capture changed where or what it is. */
		onSaved?: () => void;
		/** Whether the person's input is being taken. False while a close is answered. */
		admits?: () => boolean;
	} = {},
) {
	let saved = $state.raw<Capture>(initial);
	let buffer = $state(initial.source);
	let attempt = $state.raw<Attempt | undefined>();
	let pathChange = $state.raw<PathChange | undefined>();
	let external = $state.raw<External | undefined>();
	let failure = $state<string | undefined>();
	let refusal = $state<string | undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let recheck = false;
	let tail: Promise<unknown> = Promise.resolve();
	/**
	 * Replaced whenever the buffer is replaced by a file's text instead of by
	 * typing. A save captured before that belongs to text that is gone.
	 */
	let typedOver: object = {};

	const dirty = () => buffer !== saved.source;
	/** Nothing to review and nothing outstanding: saving may run. */
	const idle = () =>
		external === undefined && attempt === undefined && pathChange === undefined;
	const unsettled = () => dirty() || !idle();

	function schedule() {
		clearTimeout(timer);
		if (!idle()) return;
		timer = setTimeout(() => void save(), TYPING_BATCH_MS);
	}

	/** One write, move, removal, or review choice at a time, in the order asked. */
	function exclusive<T>(work: () => Promise<T>): Promise<T> {
		const result = tail.then(work);
		tail = result.catch(() => {});
		return result;
	}

	async function read(path: string): Promise<Observed> {
		try {
			const found = await readTextFile(files, path);
			if (found.error)
				return found.error.name === 'NotFound'
					? { kind: 'removed' }
					: { kind: 'unreadable', message: found.error.message };
			return found.data.kind === 'text'
				? { kind: 'present', file: found.data.file }
				: { kind: 'unreadable', message: 'The file is no longer text.' };
		} catch (cause) {
			return {
				kind: 'unreadable',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
	}

	/**
	 * Show the saved text when the buffer is the same bytes. The two differ as
	 * strings only where encoding replaced an unpaired surrogate. The file can
	 * never hold that string, so it would stay dirty and be sent again without
	 * end. Typing that encodes to other bytes is left as it is.
	 */
	function acknowledge() {
		if (
			buffer !== saved.source &&
			submittedText(buffer).source === saved.source
		)
			buffer = saved.source;
	}

	/**
	 * Agree that `next` is what the file holds. No attempt is touched, and the
	 * buffer keeps every byte it has.
	 */
	function agree(next: Capture) {
		saved = next;
		external = undefined;
		failure = undefined;
		acknowledge();
	}

	function apply(observed: Observed): ObserveOutcome {
		// Where the file is, or whether it is, is not known: one read of one
		// path concludes nothing.
		if (pathChange !== undefined) return 'same';
		if (observed.kind === 'present') {
			const next = observed.file;
			if (next.path !== saved.path) return 'same';
			if (
				attempt?.state === 'unconfirmed' &&
				attempt.path === next.path &&
				attempt.source === next.source
			) {
				// Exactly the attempted text is in the file. It is what is saved
				// now, whichever command wrote it. Nothing is scheduled: newer
				// typing waits for the person's next edit, Save, or close.
				agree(next);
				attempt = undefined;
				return 'reconciled';
			}
			if (next.sha256 === saved.sha256) {
				// A conflict whose other side went back to what was agreed is over.
				if (external !== undefined) {
					external = undefined;
					if (dirty()) schedule();
				}
				return 'same';
			}
			clearTimeout(timer);
			// A clean session follows the file. One with a write still out does
			// not, whatever its buffer holds: other text never becomes its base.
			if (!dirty() && attempt === undefined) {
				agree(next);
				buffer = next.source;
				refusal = undefined;
				typedOver = {};
				return 'adopted';
			}
			// The same bytes seen again are the same review target.
			if (
				!(
					external?.kind === 'changed' &&
					external.current.sha256 === next.sha256
				)
			)
				external = { kind: 'changed', current: next };
			return 'conflict';
		}
		clearTimeout(timer);
		if (observed.kind === 'removed') {
			// A session that still holds an attempt is not forgotten by a read.
			if (!dirty() && attempt === undefined) return 'gone';
			if (external?.kind !== 'removed') external = { kind: 'removed' };
			return 'conflict';
		}
		if (
			!(
				external?.kind === 'unreadable' && external.message === observed.message
			)
		)
			external = { kind: 'unreadable', message: observed.message };
		return 'conflict';
	}

	/** The one write. It records the attempt and changes nothing else. */
	function send(sent: Submission) {
		failure = undefined;
		attempt = { ...sent, state: 'sent' };
		const { path, source } = sent;
		return ask(() =>
			sent.kind === 'create'
				? files.create(path, source)
				: files.replace({ path, sha256: sent.expectedSha256 }, source),
		);
	}

	/**
	 * Take the folder's reply to `sent`.
	 *
	 * `reissued` marks a second send of an unconfirmed attempt. Its success
	 * acknowledges what was sent. Any other reply is about the reissue only:
	 * the first send may still be out, so the attempt stays, and what a
	 * refusal's read finds is handled as any observation is.
	 *
	 * `alternate` names another path for a first exclusive write that found its
	 * own path occupied by other text. A reissue never gets one: its own earlier
	 * write may be the occupant.
	 */
	async function conclude(
		sent: Submission,
		answer: FileOutcome<FileCapture>,
		{
			reissued = false,
			alternate,
		}: { reissued?: boolean; alternate?: () => string } = {},
	): Promise<void> {
		if (answer.kind === 'done') {
			// Only the submitted text is acknowledged, at the capture returned.
			agree({ ...answer.value, source: sent.source });
			attempt = undefined;
			onSaved();
		} else if (answer.kind === 'failed' && !reissued) {
			attempt = undefined;
			failure = answer.message;
		} else if (answer.kind !== 'refused' || reissued) {
			attempt = { ...sent, state: 'unconfirmed', problem: answer.message };
			if (answer.kind === 'refused') {
				recheck = false;
				const now = await read(sent.path);
				if (sent.path === saved.path) apply(now);
				else if (now.kind === 'present' && now.file.source === sent.source) {
					// The same equality, at the other path the attempt was sent to.
					agree(now.file);
					attempt = undefined;
				}
				if (attempt === undefined) onSaved();
			}
		} else {
			recheck = false;
			const now = await read(sent.path);
			if (now.kind === 'present' && now.file.source === sent.source) {
				// This write was refused, and the text is there all the same.
				agree(now.file);
				attempt = undefined;
				onSaved();
			} else if (alternate !== undefined && sent.kind === 'create') {
				const elsewhere = { ...sent, path: alternate() };
				await conclude(elsewhere, await send(elsewhere));
				return;
			} else {
				attempt = undefined;
				const before = external;
				if (sent.path === saved.path) apply(now);
				// Nothing new was learned about the file: say why the write was refused.
				if (external === before) failure = answer.message;
			}
		}
		await settleRecheck();
		// Only a confirmed write goes on to save what was typed meanwhile. A
		// read that found the attempted text publishes nothing by itself.
		if (answer.kind === 'done' && dirty()) schedule();
	}

	/** An observation that arrived mid-operation may have been the operation's own. */
	async function settleRecheck() {
		if (!recheck) return;
		recheck = false;
		apply(await read(saved.path));
	}

	/**
	 * Save `text`, the buffer as it was when the save was asked for, over
	 * whatever this session agrees is saved when its turn comes. Text whose
	 * bytes are already the saved ones is not sent.
	 */
	async function saveText(text: string, typed: object) {
		if (!idle() || typed !== typedOver || text === saved.source) return;
		const { source } = submittedText(text);
		if (source === saved.source) return acknowledge();
		const sent: Submission = {
			kind: 'replace',
			path: saved.path,
			source,
			expectedSha256: saved.sha256,
		};
		await conclude(sent, await send(sent));
	}

	/** Save the current buffer. Resolves when this session's writes have settled. */
	function save(): Promise<void> {
		clearTimeout(timer);
		const source = buffer;
		const typed = typedOver;
		return exclusive(() => saveText(source, typed));
	}

	/**
	 * Settle the buffer, then run one move or removal of this file. Its
	 * outcome is kept when it is unknown or partial.
	 */
	function changePath<T>(
		step: (from: FileCapture) => PathStep,
		run: (from: FileCapture) => Promise<FileOutcome<T>>,
	): Promise<FileOutcome<T> | { readonly kind: 'unsettled' }> {
		// Not taken while input is fenced; the owner says why.
		if (!admits()) return Promise.resolve({ kind: 'unsettled' });
		clearTimeout(timer);
		const source = buffer;
		const typed = typedOver;
		return exclusive(async () => {
			await saveText(source, typed);
			if (unsettled()) return { kind: 'unsettled' } as const;
			const sent = step({ path: saved.path, sha256: saved.sha256 });
			pathChange = { ...sent, state: 'sent' };
			const answer = await run(sent.from);
			if (answer.kind === 'unconfirmed' || answer.kind === 'partial') {
				pathChange = { ...sent, state: answer.kind, problem: answer.message };
			} else {
				pathChange = undefined;
				if (answer.kind === 'done' && sent.kind === 'move') {
					saved = { ...saved, path: sent.to };
					onSaved();
				} else if (answer.kind !== 'done') {
					// Refused or failed outright: nothing changed. See what is there.
					recheck = true;
				}
			}
			await settleRecheck();
			if (dirty()) schedule();
			return answer;
		});
	}

	function observe(observed: Observed): ObserveOutcome {
		if (attempt?.state === 'sent' || pathChange?.state === 'sent') {
			recheck = true;
			return 'deferred';
		}
		return apply(observed);
	}

	return {
		get saved() {
			return saved;
		},
		get buffer() {
			return buffer;
		},
		/** The write that is running, or one whose outcome is unknown. */
		get attempt() {
			return attempt;
		},
		/** The move or removal that is running, or one whose outcome is unknown or partial. */
		get pathChange() {
			return pathChange;
		},
		get external() {
			return external;
		},
		/** Why the last write was refused or failed; cleared by the next one. */
		get failure() {
			return failure;
		},
		/** Why the last structured change was refused; typing clears it. */
		get refusal() {
			return refusal;
		},
		get dirty() {
			return dirty();
		},
		get path() {
			return saved.path;
		},
		get status(): SessionStatus {
			if (pathChange !== undefined)
				return pathChange.state === 'sent' ? 'saving' : 'unconfirmed';
			if (attempt !== undefined)
				return attempt.state === 'sent' ? 'saving' : 'unconfirmed';
			if (external !== undefined) return 'conflict';
			if (failure !== undefined) return 'failed';
			return dirty() ? 'dirty' : 'saved';
		},
		/** Whether leaving now could lose something: typing, an open change, or a conflict. */
		get unsettled() {
			return unsettled();
		},
		/** Whether the person's input and choices are being taken. */
		get admitting() {
			return admits();
		},
		/**
		 * Replace the whole buffer, as a source editor does. Returns false, and
		 * takes nothing, while input is fenced; a view must not show that text.
		 */
		input(text: string): boolean {
			if (!admits()) return false;
			buffer = text;
			refusal = undefined;
			schedule();
			return true;
		},
		/** Record that a requested change could not be applied; the buffer is unchanged. */
		refuse(reason: string) {
			refusal = reason;
		},
		save,
		/**
		 * Try again. An unconfirmed write is submitted again exactly as it was:
		 * the same path, text, and condition, never the newer buffer. Otherwise
		 * the buffer is saved. An unknown or partial move or removal has no
		 * retry.
		 */
		retry(): Promise<void> {
			if (!admits()) return Promise.resolve();
			clearTimeout(timer);
			const typedText = buffer;
			const typed = typedOver;
			return exclusive(async () => {
				if (pathChange !== undefined) return;
				if (attempt?.state === 'unconfirmed') {
					const sent: Submission =
						attempt.kind === 'create'
							? { kind: 'create', path: attempt.path, source: attempt.source }
							: {
									kind: 'replace',
									path: attempt.path,
									source: attempt.source,
									expectedSha256: attempt.expectedSha256,
								};
					await conclude(sent, await send(sent), { reissued: true });
				} else await saveText(typedText, typed);
			});
		},
		/**
		 * Report a fresh read of this path. A clean session adopts changed bytes
		 * without writing; a dirty one keeps its buffer and records the other
		 * sha256. An unconfirmed write is ended only by a read of exactly its
		 * text, and an unknown move or removal by no read at all.
		 */
		observe,
		/**
		 * Read this path now and report what is there. A read that the session
		 * moved on from while it ran, by a save or a rename, is dropped.
		 */
		async reread(): Promise<ObserveOutcome> {
			const at = saved;
			const observed = await read(at.path);
			return saved === at ? observe(observed) : 'same';
		},
		/**
		 * Conflict choice: save my text over exactly the version I reviewed.
		 * `reviewed` is the `external` that was shown. Returns false, and writes
		 * nothing, when it is no longer the current one or something is still
		 * outstanding.
		 *
		 * A reviewed `removed` or `unreadable` is saved as a new file at this
		 * path. `alternate` names another path to use when this one turns out to
		 * hold other text.
		 */
		saveMine(reviewed: External, alternate?: () => string): Promise<boolean> {
			if (!admits() || reviewed !== external) return Promise.resolve(false);
			clearTimeout(timer);
			const text = buffer;
			return exclusive(async () => {
				if (
					reviewed !== external ||
					attempt !== undefined ||
					pathChange !== undefined
				)
					return false;
				const { source } = submittedText(text);
				const sent: Submission =
					reviewed.kind === 'changed'
						? {
								kind: 'replace',
								path: saved.path,
								source,
								expectedSha256: reviewed.current.sha256,
							}
						: { kind: 'create', path: saved.path, source };
				await conclude(sent, await send(sent), { alternate });
				return true;
			});
		},
		/**
		 * Conflict choice: discard my text and take exactly the sha256 I
		 * reviewed. Returns false when it is no longer the current one or
		 * something is still outstanding.
		 */
		takeTheirs(reviewed: External): boolean {
			if (
				!admits() ||
				reviewed !== external ||
				reviewed.kind !== 'changed' ||
				attempt !== undefined ||
				pathChange !== undefined
			)
				return false;
			clearTimeout(timer);
			agree(reviewed.current);
			buffer = reviewed.current.source;
			refusal = undefined;
			typedOver = {};
			return true;
		},
		/** Save pending input, and say whether nothing is left open. */
		async settle(): Promise<boolean> {
			await save();
			return !unsettled();
		},
		/**
		 * Rename or move the file. The move is conditional on the saved capture
		 * and on the destination not existing, so it never carries text this
		 * session has not seen. The session follows the file only on a `done`.
		 */
		move(to: string) {
			return changePath(
				(from) => ({ kind: 'move', from, to }),
				(from) => moveFile(files, from, to),
			);
		},
		/**
		 * Remove the file as `confirmed` captured it, which is what the person
		 * was shown when asked. A session that is not settled refuses, and the
		 * folder refuses a file that is no longer those bytes.
		 */
		remove(confirmed: FileCapture) {
			return changePath(
				() => ({ kind: 'remove', from: confirmed }),
				(from) => removeFile(files, from),
			);
		},
		dispose() {
			clearTimeout(timer);
		},
	};
}
