import { systemShortcuts } from '#platform/system-shortcuts';
import type { Command } from '$lib/commands';
import { focusedShortcuts } from '$lib/platform/focused-shortcuts';

/**
 * The single backend the recording-key hint reads. The hint shows one label, so
 * it cannot use the reach router (which exposes both slots). On desktop the
 * system (global) key is the one that fires from anywhere, so it leads; web has
 * only the focused backend. The flat settings list (a later phase) shows both
 * slots through the router; this single-label hint keeps the simple selection.
 */
const primaryShortcuts = systemShortcuts ?? focusedShortcuts;

/**
 * Preference order for the shortcut that starts each recording mode: the first
 * command with a binding live on this platform wins.
 *
 * Manual recording has two start commands. Desktop binds push-to-talk (Fn) by
 * default and ships the tap-toggle unbound; the browser ships push-to-talk
 * unbound and the toggle bound. So push-to-talk leads and the toggle backs it
 * up, and whichever the user actually bound is the one we show. VAD has a single
 * command, so its list has one entry.
 */
const RECORDING_SHORTCUT_PREFERENCE = {
	manual: ['pushToTalk', 'toggleManualRecording'],
	vad: ['toggleVadRecording'],
} as const satisfies Record<string, readonly Command['id'][]>;

export type RecordingShortcutMode = keyof typeof RECORDING_SHORTCUT_PREFERENCE;

/**
 * The display label for the shortcut that actually starts this recording mode on
 * this platform, resolved through the primary shortcut backend.
 *
 * Reading a single command (`currentLabel('toggleManualRecording')`) rendered an
 * empty key on a fresh desktop install, where the toggle ships unbound and
 * push-to-talk (Fn) is the gesture that works. Routing through the preference
 * list shows the bound gesture instead. Returns `''` when nothing in the list is
 * bound; callers hide the hint and fall back to "click".
 */
export function getRecordingShortcutLabel(mode: RecordingShortcutMode): string {
	for (const commandId of RECORDING_SHORTCUT_PREFERENCE[mode]) {
		const label = primaryShortcuts.currentLabel(commandId);
		if (label) return label;
	}
	return '';
}
