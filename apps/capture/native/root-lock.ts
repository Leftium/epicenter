/**
 * One owner per Capture directory, across processes.
 *
 * Two Epicenter processes can name the same directory: a development and a
 * production build share it whenever `EPICENTER_FOLDER_DIR` points both at
 * one place. Each would queue its own saves and commits, and neither would
 * see the other's. The lock is taken on the canonical directory before Git is
 * initialized there, so the second process refuses instead.
 *
 * The lock is an exclusive SQLite transaction on a file beside the directory.
 * SQLite holds it with an operating-system file lock, which the system
 * releases when the process ends, however it ends. There is no stale lock to
 * detect and nothing to recover after a forced kill: the next process simply
 * acquires it. The file itself is never deleted, so a live owner's lock is
 * never removed by anyone.
 *
 * The lock path must be this owner's own file. A symbolic link or anything
 * other than a regular file there is refused before it is opened, so the lock
 * is never taken on a database somewhere else. Like the folder's private Git
 * layout, this is checked once, when the lock is taken; it does not defend
 * against a program that swaps a link in afterward.
 *
 * Operating-system file locks are unreliable on some network filesystems; a
 * Capture directory there is not protected by this.
 */
import { Database } from 'bun:sqlite';
import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type RootLock = {
	/** The lock file, beside the directory it guards. */
	readonly path: string;
	release(): void;
};

export class RootBusyError extends Error {
	constructor(readonly root: string) {
		super(
			`Another Epicenter is already using the Capture folder at ${root}. Quit the other Epicenter, then open Capture again. A development and a production build share this folder when both are pointed at it.`,
		);
		this.name = 'RootBusyError';
	}
}

/** Where the lock for a canonical root lives: a sibling, outside the folder's files. */
export function rootLockPath(root: string): string {
	return join(dirname(root), `.${basename(root)}.epicenter-lock`);
}

/** Take the lock for a canonical root, or throw `RootBusyError` at once. */
export function acquireRootLock(root: string): RootLock {
	const path = rootLockPath(root);
	const existing = lstatSync(path, { throwIfNoEntry: false });
	if (existing !== undefined && !existing.isFile())
		throw new Error(
			`The Capture folder at ${root} could not be locked: ${path} is ${existing.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}. Remove it, then open Capture again.`,
		);
	const database = new Database(path, { create: true });
	try {
		// Refuse immediately; waiting would only delay telling the person.
		database.run('PRAGMA busy_timeout = 0');
		database.run('BEGIN EXCLUSIVE');
	} catch (cause) {
		database.close();
		const code = (cause as { code?: string }).code ?? '';
		if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
			throw new RootBusyError(root);
		throw new Error(
			`The Capture folder at ${root} could not be locked: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	}
	let released = false;
	return {
		path,
		release() {
			if (released) return;
			released = true;
			try {
				database.run('ROLLBACK');
			} finally {
				database.close();
			}
		},
	};
}
