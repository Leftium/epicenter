/**
 * Repeatable publication and commit failures, for a debug shell only.
 *
 * Publication failures are counted: arming "fail the next N row writes" makes
 * exactly the next N attempts fail and then publication works again, so a test
 * can exercise failure and retry in a fixed order.
 *
 * A recording is published as one folder batch: the audio file, then the row.
 * Nothing here answers for the folder. An armed failure puts an empty
 * directory at the path of the step that should fail, lets the real batch
 * run, and removes the directory afterward. The folder then fails that step
 * itself: an obstructed row leaves the audio saved and reports its own
 * `Partial`, and an obstructed audio file fails before anything is written.
 * A path that is already occupied is left alone and the attempt is not
 * counted, since the folder refuses it without help.
 *
 * Commit failures are real: a lock file is created on the branch ref, where an
 * interrupted Git process leaves one, so Git refuses to move the branch and
 * the commit pass fails while file saves keep working.
 *
 * That lock path belongs to Git. The injected lock is created exclusively, so
 * it never replaces a lock another process holds, and it carries a marker
 * unique to this host. Only a lock whose content is that marker is ever
 * removed. A lock this host did not create is left exactly as found, including
 * one left by an earlier debug host that stopped without cleaning up.
 *
 * A release shell never constructs this.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DataDefinition } from '@epicenter/definition';
import {
	type Folder,
	pathProblem,
	rowPath,
	stemProblem,
} from '@epicenter/folder/bun';
import { RECORDINGS } from '../src/lib/definition.js';

export type InjectionState = {
	/** How many upcoming recording publications fail at the row, after the audio lands. */
	rowWrites: number;
	/** How many upcoming new recording publications fail at the audio, before anything lands. */
	audioWrites: number;
	/** Whether the branch ref is locked, so commits cannot be recorded. */
	commitsBlocked: boolean;
};

/** The step of a recording's batch that an armed failure obstructs. */
type Obstacle = {
	readonly counter: 'rowWrites' | 'audioWrites';
	/** The folder-relative path the step writes. */
	readonly path: string;
};

/** Starts the content of every lock a debug host creates. */
export const LOCK_MARKER_PREFIX = 'whispering-debug-lock';

const count = (value: unknown) =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: undefined;

export function createFailureInjection({
	root,
	folder,
}: {
	root: string;
	folder: Folder<DataDefinition>;
}) {
	const branchLock = join(
		root,
		'.git',
		'refs',
		'heads',
		`${folder.git.snapshot.branch}.lock`,
	);
	const state: InjectionState = {
		rowWrites: 0,
		audioWrites: 0,
		commitsBlocked: false,
	};

	/**
	 * Which step of this call an armed failure applies to, if any. Only a batch
	 * that creates a recording row is a recording's publication. The paths come
	 * from the page, so each is checked before it is joined onto the root.
	 */
	function obstacleFor(
		path: readonly string[],
		args: readonly unknown[],
	): Obstacle | undefined {
		if (path.length !== 1 || path[0] !== 'batch' || !Array.isArray(args[0]))
			return undefined;
		const steps = args[0] as readonly Record<string, unknown>[];
		const row = steps.find(
			(step) => step?.op === 'tables.create' && step.table === RECORDINGS,
		);
		const stem = (row?.input as { stem?: unknown } | undefined)?.stem;
		if (typeof stem !== 'string' || stemProblem(stem) !== undefined)
			return undefined;
		const audio = steps.find((step) => step?.op === 'files.create')?.path;
		if (
			state.audioWrites > 0 &&
			typeof audio === 'string' &&
			pathProblem(audio) === undefined
		)
			return { counter: 'audioWrites', path: audio };
		if (state.rowWrites > 0)
			return { counter: 'rowWrites', path: rowPath(RECORDINGS, stem) };
		return undefined;
	}

	/**
	 * Put an empty directory where the step writes. Returns how to remove it,
	 * or undefined when something is already there.
	 */
	async function obstruct(
		obstacle: Obstacle,
	): Promise<(() => Promise<void>) | undefined> {
		const target = join(root, ...obstacle.path.split('/'));
		const parent = dirname(target);
		const madeParent = await mkdir(parent, { recursive: true });
		const removeParent = async () => {
			// Only a directory this created, and only while it is still empty.
			if (madeParent !== undefined) await rmdir(parent).catch(() => {});
		};
		try {
			await mkdir(target);
		} catch (cause) {
			await removeParent();
			if (codeOf(cause) === 'EEXIST') return undefined;
			throw cause;
		}
		state[obstacle.counter] -= 1;
		return async () => {
			await rmdir(target).catch(() => {});
			await removeParent();
		};
	}

	/** What this host writes into a lock it creates. Git never writes this. */
	const marker = `${LOCK_MARKER_PREFIX} ${randomUUID()}\n`;
	const codeOf = (cause: unknown) => (cause as { code?: string })?.code;

	/** Create the lock, or refuse because one is already there. */
	async function lockBranch() {
		await mkdir(join(branchLock, '..'), { recursive: true });
		try {
			await writeFile(branchLock, marker, { flag: 'wx' });
		} catch (cause) {
			if (codeOf(cause) !== 'EEXIST') throw cause;
			const found = await readFile(branchLock, 'utf8').catch(() => '');
			throw new Error(
				found.startsWith(LOCK_MARKER_PREFIX)
					? `${branchLock} is a lock left by an earlier debug session. It was not replaced. Remove it by hand if no other Whispering is running.`
					: `${branchLock} is held by another Git process. It was not replaced.`,
			);
		}
	}

	/** Remove the lock only when it is the one this host created. */
	async function unlockBranch(): Promise<void> {
		let found: string;
		try {
			found = await readFile(branchLock, 'utf8');
		} catch (cause) {
			if (codeOf(cause) === 'ENOENT') return;
			throw cause;
		}
		// Someone removed ours and took the lock: it is theirs now.
		if (found !== marker) return;
		await unlink(branchLock);
	}

	async function arm(change: Record<string, unknown>): Promise<InjectionState> {
		state.rowWrites = count(change.rowWrites) ?? state.rowWrites;
		state.audioWrites = count(change.audioWrites) ?? state.audioWrites;
		if (
			typeof change.commitsBlocked === 'boolean' &&
			change.commitsBlocked !== state.commitsBlocked
		) {
			if (change.commitsBlocked) await lockBranch();
			else await unlockBranch();
			state.commitsBlocked = change.commitsBlocked;
		}
		return { ...state };
	}

	return {
		get state(): InjectionState {
			return { ...state };
		},
		arm,
		/** Release this host's own lock when it stops. Other locks are not touched. */
		async release() {
			if (!state.commitsBlocked) return;
			await unlockBranch().catch(() => {});
			state.commitsBlocked = false;
		},
		/**
		 * Run one bridged folder call, with an armed failure in its way when one
		 * applies. The answer is always the folder's own.
		 */
		async around<T>(
			path: readonly string[],
			args: readonly unknown[],
			call: () => Promise<T>,
		): Promise<T> {
			const obstacle = obstacleFor(path, args);
			const clear = obstacle && (await obstruct(obstacle));
			try {
				return await call();
			} finally {
				await clear?.();
			}
		},
	};
}

export type FailureInjection = ReturnType<typeof createFailureInjection>;
