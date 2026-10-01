/**
 * Repeatable publication and commit failures, for a debug shell only.
 *
 * Publication failures are counted: arming "fail the next N row writes" makes
 * exactly the next N attempts fail and then publication works again, so a test
 * can exercise failure and retry in a fixed order. A failed row write lands
 * the audio file first, as a real native partial publication does, and answers
 * with the same `Partial` error the file boundary reports.
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
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataDefinition } from '@epicenter/app/definition';
import { ApplyError, FileError, type Folder } from '@epicenter/app/files';
import { RECORDING_ROW, RECORDINGS } from '../src/lib/definition.js';

export type InjectionState = {
	/** How many upcoming recording row writes fail. */
	rowWrites: number;
	/** How many upcoming recording audio writes fail before anything lands. */
	audioWrites: number;
	/** Whether the branch ref is locked, so commits cannot be recorded. */
	commitsBlocked: boolean;
};

type CreateInput = {
	stem?: string;
	attachment?: { extension: string; bytes: Uint8Array };
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
	const injected = (what: string) =>
		new Error(`injected ${what} failure (debug)`);

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
		 * Answer a folder call with an armed failure, or return undefined to let
		 * the real call run.
		 */
		async intercept(
			path: readonly string[],
			args: readonly unknown[],
		): Promise<{ readonly value: unknown } | undefined> {
			const call = path.join('.');
			if (call === `tables.${RECORDINGS}.create`) {
				const input = (args[0] ?? {}) as CreateInput;
				if (input.stem === undefined) return undefined;
				const row = `${RECORDINGS}/${input.stem}.md`;
				const audio =
					input.attachment === undefined
						? undefined
						: `${RECORDINGS}/${input.stem}.${input.attachment.extension}`;
				if (audio !== undefined && state.audioWrites > 0) {
					state.audioWrites -= 1;
					return {
						value: FileError.Io({
							path: audio,
							operation: 'create',
							cause: injected('audio write'),
						}),
					};
				}
				if (state.rowWrites === 0) return undefined;
				state.rowWrites -= 1;
				const failure = FileError.Io({
					path: row,
					operation: 'create',
					cause: injected('row write'),
				});
				if (audio === undefined || input.attachment === undefined)
					return { value: failure };
				// Use the folder boundary to validate the directory and literal path.
				// Land bytes externally: a partial publication requests no history.
				const directory = await folder.files.mkdir(RECORDINGS);
				if (directory.error) return { value: directory };
				const current = await folder.files.read(audio);
				if (current.error && current.error.name !== 'NotFound')
					return { value: current };
				if (current.error === null)
					return {
						value: FileError.Conflict({
							path: audio,
							expected: 'absent',
							actual: current.data.version,
						}),
					};
				try {
					await writeFile(join(root, audio), input.attachment.bytes, {
						flag: 'wx',
					});
				} catch (cause) {
					return {
						value: FileError.Io({ path: audio, operation: 'create', cause }),
					};
				}
				// The external write bypassed publication's status invalidation.
				await folder.git.status();
				return {
					value: ApplyError.Partial({
						applied: [{ kind: 'write', path: audio }],
						failed: { kind: 'write', path: row },
						error: failure.error,
						notAttempted: [],
					}),
				};
			}
			if (
				call === 'files.write' &&
				typeof args[0] === 'string' &&
				RECORDING_ROW.test(args[0]) &&
				(args[2] as { expected?: unknown } | undefined)?.expected ===
					'absent' &&
				state.rowWrites > 0
			) {
				state.rowWrites -= 1;
				return {
					value: FileError.Io({
						path: args[0],
						operation: 'create',
						cause: injected('row write'),
					}),
				};
			}
			return undefined;
		},
	};
}

export type FailureInjection = ReturnType<typeof createFailureInjection>;
