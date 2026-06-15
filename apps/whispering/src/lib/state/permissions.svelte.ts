import { on } from 'svelte/events';
import { Ok } from 'wellcrafted/result';
import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { report } from '$lib/report';

export type PermissionStatus = 'checking' | 'granted' | 'denied';

/**
 * Single owner of the macOS OS-permission facts the desktop dictation flow
 * depends on: Accessibility (the gate for the rdev global listener and
 * paste-back) and Microphone. One app-wide instance — the always-on listener
 * starter, the Accessibility notice, the shortcut recorder, and the guide
 * dialog all READ this instead of each calling `tauri.permissions.*.check()` on
 * their own.
 *
 * Re-check policy (no steady-state poll): seed once at `attach()`, then
 * re-check whenever the window regains focus. Returning from System Settings
 * is a window-focus event, which is the only moment a grant realistically
 * flips, so a 1 Hz timer would only burn cycles to catch a transition the OS
 * already announces for free. Off macOS desktop there is no gate, so both
 * facts read `granted` and the focus listener is never installed.
 */
function createPermissions() {
	let accessibility = $state<PermissionStatus>('checking');
	let microphone = $state<PermissionStatus>('checking');

	// Dev-only override to exercise the Accessibility notice and guide without
	// touching System Settings. `null` means "use the live OS value". The
	// `import.meta.env.DEV` guard in `effectiveAccessibility` makes this dead in
	// production (the real probe always wins), so it can never ship a bypass.
	let accessibilityOverride = $state<PermissionStatus | null>(null);

	/** The status callers see: the dev override when set, else the live probe. */
	function effectiveAccessibility(): PermissionStatus {
		if (import.meta.env.DEV && accessibilityOverride) return accessibilityOverride;
		return accessibility;
	}

	// `tauri && os.isApple` is the only configuration with a real OS gate.
	const isGated = Boolean(tauri && os.isApple);

	async function refresh() {
		if (!tauri || !isGated) {
			accessibility = 'granted';
			microphone = 'granted';
			return;
		}
		const [acc, mic] = await Promise.all([
			tauri.permissions.accessibility.check(),
			tauri.permissions.microphone.check(),
		]);
		// A failed check reads as denied: we would rather guide the user than
		// silently start a listener that can never see keys.
		accessibility = acc.data ? 'granted' : 'denied';
		microphone = mic.data ? 'granted' : 'denied';
	}

	return {
		get accessibility(): PermissionStatus {
			return effectiveAccessibility();
		},
		get microphone(): PermissionStatus {
			return microphone;
		},
		get accessibilityGranted(): boolean {
			return effectiveAccessibility() === 'granted';
		},
		get microphoneGranted(): boolean {
			return microphone === 'granted';
		},

		/** Re-probe both permissions. Called at launch and on every window focus. */
		refresh,

		/**
		 * Dev-only: pin the Accessibility status (or `null` to resume the live
		 * value) so the denied/granted UI can be toggled in real time. No-op in
		 * production via the guard in `effectiveAccessibility`.
		 */
		get accessibilityOverride(): PermissionStatus | null {
			return accessibilityOverride;
		},
		setAccessibilityOverride(status: PermissionStatus | null) {
			accessibilityOverride = status;
		},

		/** Prompt for Accessibility (opens the system prompt / Settings). */
		async requestAccessibility(): Promise<void> {
			if (!tauri) return;
			const { data, error } = await tauri.permissions.accessibility.request();
			if (error) {
				report.error({
					title: 'Accessibility permission failed',
					cause: error,
				});
				return;
			}
			accessibility = data ? 'granted' : 'denied';
		},

		/**
		 * Open System Settings to the Accessibility pane. A pass-through to the
		 * platform (no state change); returns the Result so callers can fall back
		 * to manual instructions when the deep-link fails.
		 */
		openAccessibilitySettings() {
			if (!tauri) return Ok(undefined);
			return tauri.permissions.accessibility.openSettings();
		},

		/** Prompt for Microphone. */
		async requestMicrophone(): Promise<void> {
			if (!tauri) return;
			const { data, error } = await tauri.permissions.microphone.request();
			if (error) {
				report.error({ title: 'Microphone permission failed', cause: error });
				return;
			}
			microphone = data ? 'granted' : 'denied';
		},

		/**
		 * Seed the initial probe and re-check on every window focus. Returns a
		 * cleanup that removes the focus listener. Call once from the root layout
		 * (alongside the other `attach()` singletons). No-op listener off the
		 * gated platforms, so callers never branch on `tauri`.
		 */
		attach(): () => void {
			void refresh();
			if (!isGated) return () => {};
			return on(window, 'focus', () => void refresh());
		},
	};
}

export const permissions = createPermissions();

/** The permissions owner's public shape (for consumers that take it by prop). */
export type Permissions = ReturnType<typeof createPermissions>;
