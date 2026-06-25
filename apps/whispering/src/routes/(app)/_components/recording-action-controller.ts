import type { Component } from 'svelte';

/**
 * What a `RecordingActionCard` needs from a recorder: its live state, the
 * presentation derived from that state, and a single toggle. Both
 * `createManualRecordingController` and `createVadRecordingController` satisfy
 * this structurally, so the card takes one `controller` prop instead of the
 * same eight-prop mapping spelled out at every call site.
 *
 * This is a shared contract (two factories implement it), so it is declared
 * explicitly here rather than derived from either factory's return type.
 */
export type RecordingActionController = {
	/** Capturing right now: drives the card's destructive "filled" treatment. */
	readonly active: boolean;
	/** Mid start or stop: drives the card's spinner. */
	readonly pending: boolean;
	readonly icon: Component<{ class?: string }>;
	readonly label: string;
	readonly description: string;
	readonly tooltip: string;
	readonly shortcutLabel: string;
	/** Start when idle, stop when active. */
	toggle(): void;
	/**
	 * Discard the in-progress capture without keeping its audio. Present only
	 * when the recorder has a discard-vs-finalize split (manual). Absent for VAD,
	 * where stopping the session is the only way to abort it, so a separate cancel
	 * would just duplicate the toggle.
	 */
	cancel?(): void;
	/**
	 * The live voice-activation signals, drawn as the small dim-dot -> lit-dot ->
	 * spinner mark beside the meter. Present only for a voice-activated controller;
	 * absent for manual, which has no listening/speech/transcribe states. So the
	 * card shows the mark exactly when this is present, instead of asking a global
	 * "is the current capture a VAD one". Like `cancel`, optional by mode.
	 */
	vad?: {
		/** VAD has latched onto speech: light the mark past mere loudness. */
		readonly speaking: boolean;
		/** A previous phrase is still transcribing beside the live meter. */
		readonly transcribing: boolean;
	};
};
