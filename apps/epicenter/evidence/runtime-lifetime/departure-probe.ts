/**
 * A Capture- or Todos-labelled window in the isolated runtime harness. It
 * follows the page ordering the departure wire requires and reports each step
 * to Rust, which decides whether the probe passed (`runtime_evidence.rs`).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	DEPARTURE_ANSWER_COMMAND,
	DEPARTURE_CHANGED_EVENT,
	DEPARTURE_STATUS_COMMAND,
	type DepartureAnswer,
	type DepartureStatus,
	parseDepartureStatus,
} from '../../src/departure-wire.ts';

type RoundStatus = Extract<DepartureStatus, { round: number }>;

/**
 * A sentinel for unsaved text: it lives only in this document, so seeing it
 * again proves the same page survived a cancelled quit.
 */
const draft = crypto.randomUUID();

function report(report: Record<string, unknown>) {
	return invoke('evidence_probe', { report: { ...report, draft } });
}

export async function probeDeparture() {
	let applied = 0;
	let handled: number | undefined;

	async function answer(status: RoundStatus, answer: DepartureAnswer) {
		return parseDepartureStatus(
			await invoke(DEPARTURE_ANSWER_COMMAND, {
				generation: status.generation,
				round: status.round,
				answer,
			}),
		);
	}

	async function read(source: string) {
		const status = parseDepartureStatus(await invoke(DEPARTURE_STATUS_COMMAND));
		if (status.version < applied) {
			await report({ kind: 'stale', source, status });
			return;
		}
		applied = status.version;
		await report({ kind: 'status', source, status });
		if (status.phase !== 'collecting' || status.round === handled) return;
		handled = status.round;
		// The harness decides whether this page stays silent, only says it is
		// deciding, keeps working with its draft, or settles at once because it
		// holds nothing unsaved.
		const mode = await invoke<'answer' | 'ask' | 'cancel' | 'silent'>(
			'evidence_probe_mode',
		);
		if (mode === 'silent') {
			await report({ kind: 'silent', round: status.round });
			return;
		}
		await answer(status, 'asking');
		if (mode === 'ask') {
			await report({ kind: 'asked', round: status.round });
			return;
		}
		if (mode === 'cancel') {
			await answer(status, 'cancel');
			await report({ kind: 'kept', round: status.round });
			return;
		}
		await report({ kind: 'answered', status: await answer(status, 'ready') });
	}

	const fail = (error: unknown) =>
		report({ kind: 'failure', error: String(error) });

	try {
		// Registration completes before the first read, so no round can start
		// unheard between them.
		await getCurrentWebviewWindow().listen(DEPARTURE_CHANGED_EVENT, () => {
			void report({ kind: 'nudge', scope: 'window' })
				.then(() => read('nudge'))
				.catch(fail);
		});
		await listen(DEPARTURE_CHANGED_EVENT, () => {
			void report({ kind: 'nudge', scope: 'global' }).catch(fail);
		});
		// Only after this read would a real page become editable.
		await read('activation');
	} catch (error) {
		await fail(error);
	}
}
