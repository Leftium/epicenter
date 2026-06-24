import { tauri } from '#platform/tauri';
import { pushToTalk } from '$lib/operations/push-to-talk';
import { dictationCapability } from '$lib/state/dictation-capability.svelte';

/**
 * Stop a held push-to-talk recording the moment the keyboard tap can no longer
 * deliver its key-up, instead of waiting out the 5-minute cap.
 *
 * Push-to-talk stops on a `Released` edge. If the macOS Accessibility grant is
 * revoked (or otherwise lost) mid-hold, the tap dies and that release never
 * arrives; `dictationCapability` flips off `active` as Rust pushes the new trust
 * value. `pushToTalk.stop()` is the owned reconcile (a no-op when nothing is
 * held, a latch during startup), so firing it on every capability drop is safe.
 *
 * This is the early-stop for the one lost-edge path that *has* a signal. The cap
 * still covers the path with none: an OS-eaten key-up where the tap stays alive
 * (sleep, lock) and the capability never changes.
 */
export function attachPushToTalkReconcile() {
	$effect(() => {
		if (!tauri) return;
		if (dictationCapability.isUnavailable) void pushToTalk.stop();
	});
	return () => {};
}
