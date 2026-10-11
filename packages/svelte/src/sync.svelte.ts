/**
 * The state a page keeps around `folder.sync` (ADR-0514, ADR-0516): whether
 * a run or an Apply is in flight, the attempt waiting for the person's
 * choices, whether its review shows, and what the folder refused in the last
 * Apply.
 *
 * `run()` and `apply(attempt, choices)` call the folder between the page's
 * `beforeSync` (wait for the open item's saves, so the checkpoint holds
 * them) and `afterSync` (read lists and the open item again). A run that
 * needs choices keeps its attempt and shows the review; a run replaces an
 * earlier attempt. Refused choices stay with the attempt as `problems`; any
 * other result of an Apply ends it.
 *
 * `describeSync` (`@epicenter/svelte/sync-line`, re-exported here) words a
 * result for a person. What the page shows, when, and whether input locks
 * while `syncing` stay with the page.
 */
import type {
	FolderSync,
	SyncAttempt,
	SyncChoiceProblem,
	SyncChoices,
	SyncOutcome,
} from '@epicenter/folder';
import { SyncError } from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';

export { describeSync, type SyncLine } from './sync-line.js';

export type SyncController = ReturnType<typeof createSyncController>;

export function createSyncController({
	folder,
	beforeSync = async () => {},
	afterSync = async () => {},
	refused = () => undefined,
}: {
	folder: { readonly sync: FolderSync };
	/** Runs before each run and Apply, such as waiting for the open item's saves. */
	beforeSync?: () => Promise<unknown>;
	/** Runs after each run and Apply, whatever it answered. */
	afterSync?: () => Promise<unknown>;
	/** Why no sync starts now, if one does not, such as a pending quit. */
	refused?: () => string | undefined;
}) {
	let syncing = $state(false);
	let attempt = $state.raw<SyncAttempt | undefined>();
	let reviewing = $state(false);
	let problems = $state.raw<readonly SyncChoiceProblem[]>([]);

	/** Why a run or an Apply cannot start now; nothing is called then. */
	const blocked = () => (syncing ? 'A sync is already running.' : refused());

	/** One folder call with `syncing` set, between the page's hooks. */
	async function step<T>(
		call: () => Promise<Result<T, SyncError>>,
	): Promise<Result<T, SyncError>> {
		syncing = true;
		try {
			await beforeSync();
			return await call();
		} finally {
			syncing = false;
			await afterSync();
		}
	}

	function end() {
		attempt = undefined;
		reviewing = false;
		problems = [];
	}

	return {
		/** A run or an Apply is in flight. */
		get syncing() {
			return syncing;
		},
		/** The attempt waiting for choices, if the last run found conflicts. */
		get attempt() {
			return attempt;
		},
		/** Whether the review shows. Hidden, it keeps its choices. */
		get reviewing() {
			return reviewing;
		},
		set reviewing(shown: boolean) {
			reviewing = shown && attempt !== undefined;
		},
		/** What the folder refused in the last Apply. */
		get problems() {
			return problems;
		},
		/** Commit, fetch, merge, and push; conflicts keep an attempt and show the review. */
		async run(): Promise<Result<SyncOutcome | SyncAttempt, SyncError>> {
			const why = blocked();
			if (why !== undefined) return SyncError.Failed({ cause: why });
			end();
			const ran = await step(() => folder.sync.run());
			if (ran.data?.kind === 'needsChoices') {
				attempt = ran.data;
				reviewing = true;
			}
			return ran;
		},
		/** Resolve with the review's choices. */
		async apply(
			answered: SyncAttempt,
			choices: SyncChoices,
		): Promise<Result<SyncOutcome, SyncError>> {
			const why = blocked();
			if (why !== undefined) return SyncError.Failed({ cause: why });
			const resolved = await step(() => folder.sync.resolve(answered, choices));
			if (resolved.error?.name === 'InvalidChoices')
				problems = resolved.error.problems;
			else if (attempt?.id === answered.id) end();
			return resolved;
		},
	};
}
