/**
 * Deterministic failures for acceptance testing.
 *
 * Nothing here runs unless the host was started with fault injection on, and
 * the host only allows that for an explicit disposable root. A held save
 * waits before it reads or writes anything, so the folder's own conditional
 * check still runs afterwards against whatever is on disk by then.
 */
import type { FaultState, Faults } from '../src/lib/bridge/contract.js';

export type FaultInjector = ReturnType<typeof createFaults>;

const NONE: Faults = {
	holdSaves: false,
	saveDelayMs: 0,
	failSaves: 0,
	failCommits: 0,
};

const count = (value: unknown, fallback: number) =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: fallback;

export function createFaults(enabled: boolean, initial: Partial<Faults> = {}) {
	let faults: Faults = { ...NONE };
	let waiting: (() => void)[] = [];

	function set(next: Partial<Faults>) {
		if (!enabled) return;
		faults = {
			holdSaves:
				typeof next.holdSaves === 'boolean' ? next.holdSaves : faults.holdSaves,
			saveDelayMs: count(next.saveDelayMs, faults.saveDelayMs),
			failSaves: count(next.failSaves, faults.failSaves),
			failCommits: count(next.failCommits, faults.failCommits),
		};
		if (!faults.holdSaves) {
			const released = waiting;
			waiting = [];
			for (const release of released) release();
		}
	}
	set(initial);

	return {
		enabled,
		state(): FaultState {
			return { ...faults, held: waiting.length };
		},
		set,
		/** Runs before a save. Resolves `false` when the save must fail unwritten. */
		async beforeSave(): Promise<boolean> {
			if (!enabled) return true;
			if (faults.holdSaves)
				await new Promise<void>((resolve) => waiting.push(resolve));
			if (faults.saveDelayMs > 0)
				await new Promise((resolve) => setTimeout(resolve, faults.saveDelayMs));
			if (faults.failSaves > 0) {
				faults = { ...faults, failSaves: faults.failSaves - 1 };
				return false;
			}
			return true;
		},
		/** Whether the commit being requested now must fail. */
		takeCommitFailure(): boolean {
			if (!enabled || faults.failCommits === 0) return false;
			faults = { ...faults, failCommits: faults.failCommits - 1 };
			return true;
		},
	};
}
