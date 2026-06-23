import { report } from '$lib/report';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { startManualRecording, stopManualRecordingIfOwned } from './recording';

/**
 * Push-to-talk owns the recording it starts. A press starts a session; a release,
 * a synthetic release from the keyboard backend (a tap restart, a binding re-sync,
 * a capture switch), or the 5-minute cap stops only THAT session.
 *
 * Two correctness properties, both of which the bare "Released calls stop" model
 * lacked, and whose absence let a lost release edge leave recording stuck on:
 *
 * - Source-scoped: a stray or duplicated release never stops a toggle or
 *   record-button recording (`stopManualRecordingIfOwned('pushToTalk')`).
 * - Startup-safe: a release that lands while the recording is still starting is
 *   latched and honored the moment it exists (`stopRequested`), where checking the
 *   recorder state alone would miss it (it is not `RECORDING` yet).
 *
 * Push-to-talk is a physical hold, so presses are sequential; the generation id
 * still scopes every stop to its session, so a stale start completion cannot arm a
 * cap for a session already released.
 */

let generation = 0;
let session: { id: number; stopRequested: boolean } | null = null;
let capTimer: ReturnType<typeof setTimeout> | undefined;

// Push-to-talk is for held dictation; long-form has the toggle command. The cap is
// the safety fuse for the one stuck-on path no edge covers (an OS-eaten key-up
// while the tap stays alive), not the primary stop, so a fixed generous value is
// enough. Not configurable until real usage asks for it.
const MAX_HOLD_MS = 5 * 60 * 1000;

function clearCap() {
	clearTimeout(capTimer);
	capTimer = undefined;
}

/**
 * The recording this session started ended by other means (cancel, toggle, a
 * surface switch) without a release reaching us, so the session is stale. True
 * only when we hold a session but the recorder is neither recording nor starting.
 */
function sessionIsStale(): boolean {
	return (
		session !== null &&
		manualRecorder.state !== 'RECORDING' &&
		!manualRecorder.isStarting
	);
}

async function end(id: number, options?: { capped?: boolean }) {
	if (session?.id !== id) return; // superseded by a newer press
	session = null;
	clearCap();
	await stopManualRecordingIfOwned('pushToTalk');
	if (options?.capped) {
		report.info({
			title: 'Recording stopped',
			description: 'Push-to-talk hit the 5-minute limit.',
		});
	}
}

async function start() {
	// Drop a stale session whose recording already ended without a release, so a
	// fresh press is never blocked by it.
	if (sessionIsStale()) {
		session = null;
		clearCap();
	}
	if (session) return; // genuinely still holding (recording or starting)

	const id = ++generation;
	session = { id, stopRequested: false };
	await startManualRecording('pushToTalk');

	// Superseded by a newer press while we awaited: that press owns the session.
	if (session?.id !== id) return;
	// Startup did not reach RECORDING (it failed; the failure already surfaced).
	if (manualRecorder.state !== 'RECORDING') {
		session = null;
		return;
	}
	// A release arrived during startup: honor it now that the recording exists.
	if (session.stopRequested) {
		await end(id);
		return;
	}
	capTimer = setTimeout(() => void end(id, { capped: true }), MAX_HOLD_MS);
}

/**
 * Stop the owned recording in response to a release or a backend reconcile signal.
 * Safe to call when not holding (no-op), when startup is still in flight (latches a
 * stop the start completion honors), and when the recording already ended (clears
 * the stale session).
 */
async function stop() {
	const current = session;
	if (!current) return; // not holding anything
	if (manualRecorder.state === 'RECORDING') {
		await end(current.id);
		return;
	}
	if (manualRecorder.isStarting) {
		current.stopRequested = true; // honored when start completes
		return;
	}
	// Not recording and not starting: the recording ended by other means.
	session = null;
	clearCap();
}

export const pushToTalk = { start, stop };
