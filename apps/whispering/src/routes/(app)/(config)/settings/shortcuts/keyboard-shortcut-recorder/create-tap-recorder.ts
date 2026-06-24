import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';
import { isEmptyBinding } from '$lib/utils/key-binding';

/** The slice of the Tauri keyboard the tap recorder needs: the capture stream. */
type CaptureKeyboard = {
	listenForCapture: (
		onCombo: (binding: KeyBinding) => void,
	) => Promise<() => void>;
};

/**
 * The native tap recorder: the desktop+Accessibility peer of
 * {@link import('./create-chord-recorder').createChordRecorder}. Both expose the
 * same `{ start, stop }` with `onCapture`/`onProgress`; they differ only in
 * source. The chord recorder reads the webview `keydown` stream and sees bare
 * keys and chords; this reads the native `shortcutCaptureEvent` stream and sees
 * the Fn and modifier-only holds the webview cannot. The owner picks one by trust
 * and never touches accumulation, so the component holds no capture state.
 *
 * The completion model mirrors the chord recorder: the native stream emits the
 * currently-held combo on every change, this unions it across the gesture, and
 * commits when everything releases (an empty combo). `onCapture` fires once per
 * gesture; the recorder then resets and keeps listening, so the owner can refuse
 * a binding and let the user retry without reopening.
 */
export function createTapRecorder({
	keyboard,
	onCapture,
	onProgress,
}: {
	keyboard: CaptureKeyboard;
	onCapture: (binding: KeyBinding) => void;
	onProgress: (binding: KeyBinding) => void;
}) {
	// Accumulated across the gesture: every modifier and key ever held, so a combo
	// built up over several presses commits whole when the last key releases.
	let modifiers = new Set<Modifier>();
	let keys = new Set<Key>();
	// `listenForCapture` resolves async; if stop() lands first, detach the moment
	// the listener arrives so it cannot leak.
	let torn = false;
	let unlisten: (() => void) | undefined;

	function reset() {
		modifiers = new Set();
		keys = new Set();
	}

	function start() {
		torn = false;
		reset();
		void keyboard
			.listenForCapture((combo) => {
				for (const modifier of combo.modifiers) modifiers.add(modifier);
				for (const key of combo.keys) keys.add(key);
				const accumulated: KeyBinding = {
					modifiers: [...modifiers],
					keys: [...keys],
				};
				// Empty combo = everything released. Commit what we accumulated, then
				// reset and keep listening; otherwise preview the held combo's reach.
				if (isEmptyBinding(combo) && modifiers.size + keys.size > 0) {
					reset();
					onCapture(accumulated);
				} else {
					onProgress(accumulated);
				}
			})
			.then((fn) => {
				if (torn) fn();
				else unlisten = fn;
			});
	}

	function stop() {
		torn = true;
		unlisten?.();
		unlisten = undefined;
		reset();
	}

	return { start, stop };
}
