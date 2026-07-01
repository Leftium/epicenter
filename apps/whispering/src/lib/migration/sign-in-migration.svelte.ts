/**
 * First-sign-in migration: move this device's signed-out local doc into the
 * signed-in, owner-partitioned synced doc.
 *
 * Flag-free: the local data itself is the state. On each signed-in boot we probe
 * the local doc for any migratable rows (recordings, transformations, or
 * transformation runs); a non-empty table opens the dialog, which nags again next
 * boot until the user picks Add or Delete. "Add" copies local rows into the owner
 * doc (idempotent by id) then deletes the plaintext local copy, so the deletion
 * both removes the lingering plaintext duplicate AND is why no "migrated" flag is
 * needed (the tables drop to 0).
 *
 * The local source is opened only momentarily (probe, then each action re-opens),
 * so nothing is held across the dialog's lifetime and a dismissed dialog leaks
 * nothing.
 */

import { toastOnError } from '@epicenter/ui/sonner';
import { attachIndexedDb } from '@epicenter/workspace';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { auth } from '#platform/auth';
import { whispering } from '#platform/whispering';
import { createWhispering } from '$lib/workspace';

const SignInMigrationError = defineErrors({
	AddFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not add your recordings to this account: ${extractErrorMessage(cause)}`,
		cause,
	}),
	DeleteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not remove the local recordings: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type SignInMigrationError = InferErrors<typeof SignInMigrationError>;

/**
 * Open a throwaway handle to the signed-out plaintext local doc (the migration
 * source). This opens the same `epicenter-whispering` IndexedDB the
 * signed-out app uses; the owner doc's storage is partitioned, so this never
 * collides with the active synced doc. `dispose()` tears down the connection
 * without deleting data (`clearLocal` does the deletion). The transcription
 * service default is irrelevant here: only table rows are copied, never KV.
 */
function openLocalSource() {
	const workspace = createWhispering({ defaultTranscriptionService: 'OpenAI' });
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: workspace.tables,
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

type LocalSource = ReturnType<typeof openLocalSource>;

/**
 * Human phrase for what is staged locally, e.g. "12 recordings",
 * "3 transformations", or "12 recordings and 3 transformations". Recordings lead
 * because they dominate; transformation runs ride along in the copy but stay out
 * of the prose (users do not think in "runs"). Falls back to "data" for the rare
 * orphan-run-only case.
 */
function describeLocalContents(counts: {
	recordings: number;
	transformations: number;
}): string {
	const parts: string[] = [];
	if (counts.recordings > 0) {
		const n = counts.recordings;
		parts.push(`${n} recording${n === 1 ? '' : 's'}`);
	}
	if (counts.transformations > 0) {
		const n = counts.transformations;
		parts.push(`${n} transformation${n === 1 ? '' : 's'}`);
	}
	return parts.length > 0 ? parts.join(' and ') : 'data';
}

/** Upsert every valid row from one table into another; idempotent by id. */
function copyTable<TRow extends { id: string }>(
	from: { scan(): { rows: TRow[] } },
	to: { set(row: TRow): { error: unknown } },
): void {
	for (const row of from.scan().rows) {
		const { error } = to.set(row);
		if (error) throw error;
	}
}

/**
 * Copy the whole local doc into the owner doc in one transaction (one observer
 * fire, one relay batch), then delete the plaintext local copy. Yjs does not
 * roll back a `transact()` callback on throw, so a mid-loop failure can leave
 * partial rows already committed to the owner doc; the safety net is that
 * `copyTable` is idempotent by id, not that the transaction is atomic. Either
 * way `clearLocal` only runs after the whole copy resolves without throwing,
 * so a failure leaves the local copy intact and the next attempt re-runs
 * safely over whatever partial state exists.
 */
async function addLocalToOwner(source: LocalSource): Promise<void> {
	await whispering.whenReady;
	whispering.ydoc.transact(() => {
		copyTable(source.tables.recordings, whispering.tables.recordings);
		copyTable(source.tables.transformations, whispering.tables.transformations);
		copyTable(
			source.tables.transformationRuns,
			whispering.tables.transformationRuns,
		);
	});
	await source.clearLocal();
}

function createSignInMigration() {
	let open = $state(false);
	let recordingCount = $state(0);
	let summary = $state('');
	let phase = $state<'idle' | 'adding' | 'deleting'>('idle');
	let hasChecked = false;

	return {
		get open() {
			return open;
		},
		set open(value: boolean) {
			// Ignore Escape/outside-click while a copy or delete is in flight; the
			// buttons are already disabled, so the dialog's own close path is the
			// one spot this guard was missing.
			if (phase !== 'idle') return;
			open = value;
		},
		get recordingCount() {
			return recordingCount;
		},
		/** Human phrase for what is staged locally (see {@link describeLocalContents}). */
		get summary() {
			return summary;
		},
		get phase() {
			return phase;
		},
		get isBusy() {
			return phase !== 'idle';
		},

		/**
		 * Probe once per boot. When signed in, open the local doc, count every table
		 * `addLocalToOwner` will copy, and dispose it. Any non-empty table opens the
		 * dialog. No flag: the presence of local rows is the state, so the prompt
		 * returns next signed-in boot until resolved.
		 *
		 * Gates on all three tables, not recordings alone: a signed-out user can
		 * build transformations (or clipboard-only transformation runs) without ever
		 * recording, and the "Add" path copies all three. Probing recordings alone
		 * would strand that data in the bare local doc, invisible under the
		 * partitioned signed-in doc, which is the exact loss this migration prevents.
		 */
		async check(): Promise<void> {
			if (hasChecked) return;
			hasChecked = true;
			if (auth.state.status === 'signed-out') return;

			const source = openLocalSource();
			let counts = { recordings: 0, transformations: 0, transformationRuns: 0 };
			try {
				await source.whenLoaded;
				counts = {
					recordings: source.tables.recordings.scan().rows.length,
					transformations: source.tables.transformations.scan().rows.length,
					transformationRuns:
						source.tables.transformationRuns.scan().rows.length,
				};
			} finally {
				source.dispose();
			}
			const total =
				counts.recordings + counts.transformations + counts.transformationRuns;
			if (total === 0) return;
			recordingCount = counts.recordings;
			summary = describeLocalContents(counts);
			open = true;
		},

		/** Copy local data into the owner doc, then delete the plaintext local copy. */
		async addToAccount(): Promise<void> {
			if (phase !== 'idle') return;
			phase = 'adding';
			const { error } = await tryAsync({
				try: async () => {
					const source = openLocalSource();
					try {
						await source.whenLoaded;
						await addLocalToOwner(source);
					} finally {
						source.dispose();
					}
				},
				catch: (cause) => SignInMigrationError.AddFailed({ cause }),
			});
			phase = 'idle';
			if (error) {
				// Local copy is untouched on failure; the dialog stays open to retry.
				toastOnError(error, error.message);
				return;
			}
			open = false;
		},

		/** Delete the plaintext local copy without copying it into the account. */
		async deleteFromDevice(): Promise<void> {
			if (phase !== 'idle') return;
			phase = 'deleting';
			const { error } = await tryAsync({
				try: async () => {
					const source = openLocalSource();
					try {
						await source.whenLoaded;
						await source.clearLocal();
					} finally {
						source.dispose();
					}
				},
				catch: (cause) => SignInMigrationError.DeleteFailed({ cause }),
			});
			phase = 'idle';
			if (error) {
				toastOnError(error, error.message);
				return;
			}
			open = false;
		},

		/** Defer: close the dialog. The next signed-in boot re-probes and nags. */
		keepForNow(): void {
			if (phase !== 'idle') return;
			open = false;
		},
	};
}

export const signInMigration = createSignInMigration();
