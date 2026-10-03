/**
 * EXPERIMENT: manual gates around the demo server's saves.
 *
 * Each gate is armed for the next save and released by hand, so a person or
 * a test can act at an exact moment: before the folder publishes, or after
 * it published but before the reply leaves. Nothing here sleeps.
 *
 * "Lose the reply" is a transport simulation. The save runs and its real
 * result is discarded; the caller is told `Unconfirmed`, which the Bun
 * folder itself never returns. It stands in for a dropped connection or a
 * desktop owner whose reply did not arrive.
 */
import { isOk, type Result } from 'wellcrafted/result';
import { FileError } from '../../src/errors.js';

export type GateName = 'beforePublication' | 'afterPublication' | 'loseReply';

export type HeldSave = {
	readonly id: number;
	readonly path: string;
	readonly stage: 'beforePublication' | 'afterPublication';
};

export type GateSnapshot = {
	readonly armed: Readonly<Record<GateName, boolean>>;
	readonly held: readonly HeldSave[];
};

export type GateEvent =
	| { readonly kind: 'changed'; readonly gates: GateSnapshot }
	| {
			readonly kind: 'published';
			readonly path: string;
			readonly sha256: string | undefined;
	  }
	| { readonly kind: 'refused'; readonly path: string; readonly error: string }
	| { readonly kind: 'replyLost'; readonly path: string };

export function createPublicationGates(onEvent: (event: GateEvent) => void) {
	const armed: Record<GateName, boolean> = {
		beforePublication: false,
		afterPublication: false,
		loseReply: false,
	};
	const held: (HeldSave & { release(): void })[] = [];
	const holdWaiters: (() => void)[] = [];
	let nextId = 1;

	function snapshot(): GateSnapshot {
		return Object.freeze({
			armed: Object.freeze({ ...armed }),
			held: Object.freeze(
				held.map(({ id, path, stage }) => ({ id, path, stage })),
			),
		});
	}

	const changed = () => onEvent({ kind: 'changed', gates: snapshot() });

	/** Take an armed gate for this save, disarming it. */
	function take(name: GateName) {
		const taken = armed[name];
		armed[name] = false;
		return taken;
	}

	function hold(path: string, stage: HeldSave['stage']) {
		const { promise, resolve } = Promise.withResolvers<void>();
		held.push({ id: nextId++, path, stage, release: resolve });
		for (const waiter of holdWaiters.splice(0)) waiter();
		changed();
		return promise;
	}

	return {
		snapshot,
		arm(name: GateName) {
			armed[name] = true;
			changed();
		},
		/** Release the oldest held save. Returns whether one was held. */
		release(): boolean {
			const first = held.shift();
			if (first === undefined) return false;
			first.release();
			changed();
			return true;
		},
		/** Disarm everything and let every held save continue. */
		reset() {
			for (const name of Object.keys(armed) as GateName[]) armed[name] = false;
			for (const save of held.splice(0)) save.release();
			changed();
		},
		/** Resolves once a save is held, now or later. */
		whenHeld(): Promise<void> {
			if (held.length > 0) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			holdWaiters.push(resolve);
			return promise;
		},
		/**
		 * Run one save through the armed gates. `publish` is the folder method
		 * call; `sha256Of` names the bytes it published, for the log.
		 */
		async run<TData, TError extends { name: string; message: string }>(
			path: string,
			publish: () => Promise<Result<TData, TError>>,
			sha256Of: (data: TData) => string | undefined,
		): Promise<Result<TData, TError | FileError>> {
			const before = take('beforePublication');
			const after = take('afterPublication');
			const lose = take('loseReply');
			if (before || after || lose) changed();
			if (before) await hold(path, 'beforePublication');
			const result = await publish();
			onEvent(
				isOk(result)
					? { kind: 'published', path, sha256: sha256Of(result.data) }
					: { kind: 'refused', path, error: result.error.message },
			);
			if (after) await hold(path, 'afterPublication');
			if (lose) {
				onEvent({ kind: 'replyLost', path });
				return FileError.Unconfirmed({
					path,
					operation: 'replace',
					cause: 'The demo harness discarded this reply',
				});
			}
			return result;
		},
	};
}

export type PublicationGates = ReturnType<typeof createPublicationGates>;
