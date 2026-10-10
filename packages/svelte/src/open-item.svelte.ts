/**
 * The one item a page has open, and how it is left.
 *
 * A page that shows one file at a time keeps it here: the item its loader
 * built, and the edit session inside it, if any. Opening another item waits
 * for the open one's saves, then releases its session. When a save failed,
 * or the app says the item holds something unsent, opening answers
 * `unsaved` with the session it means, and the app asks the person; opening
 * again with `{ discard: session }` lets that draft go. A load that answers
 * after a newer open is released and never shown. Opening the item already
 * shown does nothing.
 *
 * The conflict commands act only on the session they are given, and only
 * while it is the open one. Reload theirs closes an item whose file is gone,
 * and opens again through the loader when the file can no longer be shown
 * as the session's value. `removeOpen` releases the session, waits for its
 * saves, and removes what the last one confirmed.
 *
 * What an item is, how it loads, listings, refusals, and what a person is
 * told stay with the app.
 */
import type { FileCapture, SaveState } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Reread } from './edit-session.svelte.js';

type Failure = { readonly name: string; readonly message: string };

/** What the slot needs of an item's edit session. */
export type OpenSession = {
	readonly path: string;
	readonly state: SaveState<Failure>;
	settled(): Promise<SaveState<Failure>>;
	release(): void;
	adopt(): Promise<boolean>;
	keepMine(): Promise<Result<undefined, Failure>>;
	reloadTheirs(): Promise<Result<Reread<unknown, unknown>, Failure>>;
};

/** What the slot shows: an item still loading, or the open item. */
export type Shown<TKey, TItem> =
	| { readonly status: 'loading'; readonly key: TKey }
	| { readonly status: 'open'; readonly key: TKey; readonly item: TItem };

/** How an open (or leave) ended. */
export type Opening<TSession> =
	/** It happened. `left` says whether an item was left, so the app can list again. */
	| { readonly kind: 'done'; readonly left: boolean }
	/** The open item holds a draft it could not save; ask, then discard this session. */
	| { readonly kind: 'unsaved'; readonly session: TSession }
	/** A newer open, a forget, or close took over; nothing more was done. */
	| { readonly kind: 'superseded' };

/** What Reload theirs did. */
export type Reloaded = 'shown' | 'closed' | 'reopened';

export function createOpenItem<TKey, TItem, TSession extends OpenSession>({
	load,
	sessionOf,
	sameKey = Object.is,
	holds = () => false,
	closed = () => false,
}: {
	/** Build the item for `key` from a fresh read; the app maps invalid rows, binary files, and failures. */
	load(key: TKey): Promise<TItem>;
	sessionOf(item: TItem): TSession | undefined;
	sameKey?(a: TKey, b: TKey): boolean;
	/** Whether the item holds input outside its session that leaving would lose. */
	holds?(item: TItem): boolean;
	/** Whether the page is closing: nothing new opens. */
	closed?(): boolean;
}) {
	let shown = $state.raw<Shown<TKey, TItem> | undefined>();
	/** Advanced by every open, forget, and reload, so a late load shows nothing. */
	let sequence = 0;

	const item = () => (shown?.status === 'open' ? shown.item : undefined);
	const current = () => {
		const it = item();
		return it === undefined ? undefined : sessionOf(it);
	};

	function holdsUnsaved(it: TItem, state: SaveState<Failure> | undefined) {
		return state?.status === 'error' || holds(it);
	}

	/** Show what `load` builds for `key`, unless something newer took over. */
	async function show(key: TKey, mine: number): Promise<boolean> {
		shown = { status: 'loading', key };
		const loaded = await load(key);
		if (mine !== sequence || closed()) {
			sessionOf(loaded)?.release();
			return false;
		}
		shown = { status: 'open', key, item: loaded };
		return true;
	}

	/** Leave what is shown. Run with the caller's sequence number. */
	async function leave(
		mine: number,
		discard: TSession | undefined,
	): Promise<Opening<TSession>> {
		const was = shown;
		if (was === undefined) return { kind: 'done', left: false };
		if (was.status === 'loading') {
			shown = undefined;
			return { kind: 'done', left: true };
		}
		const session = sessionOf(was.item);
		const state = await session?.settled();
		if (mine !== sequence || shown !== was) return { kind: 'superseded' };
		if (session !== undefined && holdsUnsaved(was.item, state) && discard !== session)
			return { kind: 'unsaved', session };
		session?.release();
		shown = undefined;
		return { kind: 'done', left: true };
	}

	function forget() {
		current()?.release();
		sequence += 1;
		shown = undefined;
	}

	async function reload(): Promise<boolean> {
		const was = shown;
		if (was === undefined || closed()) return false;
		const mine = ++sequence;
		if (was.status === 'open') sessionOf(was.item)?.release();
		return show(was.key, mine);
	}

	return {
		/** What is shown: loading, or the open item. */
		get shown() {
			return shown;
		},
		get item() {
			return item();
		},
		get session() {
			return current();
		},
		/** A save is running or failed, or the item holds unsent input. */
		get unsaved() {
			const it = item();
			if (it === undefined) return false;
			const state = sessionOf(it)?.state;
			return state?.status === 'saving' || holdsUnsaved(it, state);
		},
		/** Open `key`: leave the open item, then show what the loader builds. */
		async open(
			key: TKey,
			{ discard }: { discard?: TSession } = {},
		): Promise<Opening<TSession>> {
			if (closed()) return { kind: 'superseded' };
			if (shown !== undefined && sameKey(shown.key, key))
				return { kind: 'done', left: false };
			const mine = ++sequence;
			const left = await leave(mine, discard);
			if (left.kind !== 'done') return left;
			if (!(await show(key, mine))) return { kind: 'superseded' };
			return left;
		},
		/** Leave the open item and show nothing. */
		leave({ discard }: { discard?: TSession } = {}) {
			return leave(++sequence, discard);
		},
		/** Close the open item without saving more; given a session, only while it is the open one. */
		forget(session?: TSession) {
			if (session === undefined || current() === session) forget();
		},
		/** Read the open item again as it is now, in a new session; nothing unsent is asked about. */
		reload,
		/** Keep mine for `session`; `undefined` when it is no longer the open one. */
		async keepMine(
			session: TSession,
		): Promise<Result<undefined, Failure> | undefined> {
			if (current() !== session) return undefined;
			return session.keepMine();
		},
		/**
		 * Reload theirs for `session`: show the file as it is now. A file that
		 * is gone closes; one that cannot be shown as the session's value
		 * opens again through the loader. `undefined` when it is no longer the
		 * open one.
		 */
		async reloadTheirs(
			session: TSession,
		): Promise<Result<Reloaded, Failure> | undefined> {
			if (current() !== session) return undefined;
			const { data: found, error } = await session.reloadTheirs();
			if (error !== null) return Err(error);
			if (current() !== session) return undefined;
			if (found.kind === 'gone') {
				forget();
				return Ok('closed');
			}
			if (found.kind === 'other') {
				await reload();
				return Ok('reopened');
			}
			return Ok('shown');
		},
		/** Take a newer version of the open item when it holds nothing unsaved. */
		async adopt(): Promise<boolean> {
			const it = item();
			if (it === undefined || holds(it)) return false;
			return (await sessionOf(it)?.adopt()) ?? false;
		},
		/**
		 * Remove the open item's file: release its session, wait for its saves,
		 * and remove what the last one confirmed. On success the item closes;
		 * when refused, it opens again as the file is now. `undefined` when
		 * `session` is no longer the open one. Admit the whole call.
		 */
		async removeOpen<TError>(
			session: TSession,
			remove: (file: FileCapture) => Promise<Result<undefined, TError>>,
		): Promise<Result<undefined, TError> | undefined> {
			if (current() !== session) return undefined;
			session.release();
			const { file } = await session.settled();
			const removed = await remove(file);
			if (current() === session) {
				if (removed.error === null) forget();
				else await reload();
			}
			return removed;
		},
		/**
		 * Wait for the open item's saves and release it. Answers its path when
		 * a draft could not be saved, which ends with the page.
		 */
		async close(): Promise<string | undefined> {
			sequence += 1;
			const it = item();
			const session = it === undefined ? undefined : sessionOf(it);
			const state = await session?.settled();
			session?.release();
			return state?.status === 'error' ? state.file.path : undefined;
		},
	};
}

export type OpenItem<TKey, TItem, TSession extends OpenSession> = ReturnType<
	typeof createOpenItem<TKey, TItem, TSession>
>;
