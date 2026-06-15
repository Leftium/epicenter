import { on } from 'svelte/events';
import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import { permissions } from '$lib/state/permissions.svelte';

/**
 * Single owner of the desktop rdev global-listener's *liveness*: it keeps the
 * one keyboard-tap thread alive whenever the platform allows it, and keeps the
 * UI honest about why it isn't.
 *
 * This collapses three mechanisms that used to be smeared across `permissions`
 * (a grant-flow poll) and `AppLayout` (a spawn-on-grant `$effect` plus a
 * death-restart supervisor) into one state machine with one timer:
 *
 *   idle ──launch─▶ awaitingGrant ──granted─▶ running
 *                        ▲                       │ thread dies
 *                        │ grant gone            ▼
 *                        └──────────────── recovering ──cap exhausted─▶ degraded
 *
 * The hard fact we design around: rdev gives us a thread-death signal but no
 * positive "alive" signal, and macOS gives us no event when Accessibility
 * flips. So liveness is *inferred* (we assume `running` after `start()` until a
 * stop event proves otherwise) and the grant is *sampled* (window focus, plus a
 * bounded poll while we are blurred and waiting).
 *
 * Why gate on the permission probe instead of just always starting and trusting
 * the thread to die when denied: Whispering uses `rdev::listen` (the passive
 * `ListenOnly` tap), whose untrusted behavior rdev's own README flags as
 * "silently ignore the callback, no error". A silently-dropping tap looks alive,
 * so liveness alone cannot stand in for the grant. `check()` (AXIsProcessTrusted)
 * is the reliable "is the app trusted" signal; the death event is the
 * complement that catches what `check()` misses (a stale post-update grant that
 * no longer satisfies the code signature). We need both.
 */
type ListenerStatus =
	| 'idle' // pre-attach, or the browser build (in-app keydown handles shortcuts)
	| 'unsupported' // Linux Wayland: rdev's tap never receives events
	| 'awaitingGrant' // macOS, Accessibility not granted: not started, sampling for it
	| 'running' // thread spawned and believed alive
	| 'recovering' // was running, thread died though the grant holds: backoff restart
	| 'degraded'; // backoff exhausted: standing notice, waiting for a focus/re-grant kick

const STOPPED_NOTICE_ID = 'global-shortcuts-stopped';
const WAYLAND_NOTICE_ID = 'wayland-unsupported';

// Backoff for an unexpected death while the grant still holds, so a genuinely
// broken tap cannot hot-loop. After the last step we give up to a standing
// notice. A death more than the reset window after the previous one starts with
// a fresh budget, because there is no positive "stayed alive" signal to reset on.
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RESTART_RESET_WINDOW_MS = 60_000;

// Bounded grant poll. It runs ONLY while we are blurred and awaiting the grant:
// the only way to grant Accessibility is in System Settings, which blurs us, and
// a toggle that lands while Settings holds focus would otherwise go unseen until
// we tab back. Focus stops the poll (the focus re-probe takes over), so it can
// never become the steady-state 1 Hz timer the permissions module rejects.
const GRANT_POLL_INTERVAL_MS = 1_000;
const GRANT_POLL_MAX_TICKS = 60;

function createGlobalListener() {
	let status: ListenerStatus = 'idle';
	let restartAttempt = 0;
	let lastStopAt = 0;
	let pollTicks = 0;
	// One timer for the whole machine: the awaitingGrant poll and the recovering
	// backoff are mutually exclusive states, so they can never both want it.
	let timer: ReturnType<typeof setTimeout> | undefined;
	let detached = false;

	function clearTimer() {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	/** macOS is the only platform with a real gate; elsewhere the grant is free. */
	function isGranted(): boolean {
		return !os.isApple || permissions.accessibilityGranted;
	}

	/**
	 * Spawn the rdev thread (idempotent in Rust) and assume it is alive until a
	 * stop event says otherwise. Wayland reports `unsupported` instead.
	 */
	async function spawn() {
		if (!tauri || detached) return;
		const result = await tauri.globalShortcuts.start();
		if (detached) return;
		if (result === 'waylandUnsupported') {
			status = 'unsupported';
			clearTimer();
			report.warning({
				id: WAYLAND_NOTICE_ID,
				title: 'Global shortcuts unavailable on Wayland',
				description:
					'Whispering needs an X11 session for global shortcuts. On Wayland, bind them through your desktop environment.',
			});
			return;
		}
		status = 'running';
		// A live listener clears any standing "stopped" notice we raised, so
		// recovery (a re-grant, a refocus) self-heals the UI.
		report.dismiss(STOPPED_NOTICE_ID);
	}

	/** macOS denied: sit and wait. The poll is armed by blur, not here. */
	function awaitGrant() {
		status = 'awaitingGrant';
		clearTimer();
	}

	/**
	 * The rdev thread exited. Re-probe to learn why, then reconcile: a vanished
	 * grant drops us back to waiting (the notice shows, the next grant respawns);
	 * a grant that still holds means an unexpected death, so restart with capped
	 * backoff and, once the cap is spent, surface one honest standing notice.
	 */
	async function onStopped() {
		if (!tauri || detached) return;
		await permissions.refresh();
		if (detached) return;
		if (!isGranted()) {
			restartAttempt = 0;
			awaitGrant();
			return;
		}
		const now = Date.now();
		if (now - lastStopAt > RESTART_RESET_WINDOW_MS) restartAttempt = 0;
		lastStopAt = now;
		if (restartAttempt >= RESTART_BACKOFF_MS.length) {
			status = 'degraded';
			clearTimer();
			report.warning({
				id: STOPPED_NOTICE_ID,
				title: 'Global shortcuts stopped',
				description:
					'Whispering could not restart the global shortcut listener. Restart the app to restore shortcuts.',
			});
			return;
		}
		const delay = RESTART_BACKOFF_MS[restartAttempt] ?? 16_000;
		restartAttempt += 1;
		status = 'recovering';
		clearTimer();
		timer = setTimeout(() => void spawn(), delay);
	}

	/**
	 * Window regained focus (or we are reconciling at launch). The focus re-probe
	 * is the reliable grant sampler, so it stops any in-flight poll and decides:
	 * granted -> (re)start with a fresh budget; denied -> wait for the next blur.
	 * A no-op while already running so a routine tab-back never respawns.
	 */
	async function onFocus() {
		if (!tauri || detached) return;
		if (status === 'running' || status === 'unsupported') return;
		clearTimer();
		await permissions.refresh();
		if (detached) return;
		if (isGranted()) {
			restartAttempt = 0;
			await spawn();
		} else {
			awaitGrant();
		}
	}

	/**
	 * Window lost focus while awaiting the grant: the user is most likely in
	 * System Settings toggling Accessibility now. Arm the bounded poll so the
	 * flip lands live, since no focus event will fire while Settings holds focus.
	 */
	function onBlur() {
		if (!tauri || detached || status !== 'awaitingGrant' || timer) return;
		pollTicks = 0;
		timer = setTimeout(pollTick, GRANT_POLL_INTERVAL_MS);
	}

	async function pollTick() {
		pollTicks += 1;
		await permissions.refresh();
		if (detached || status !== 'awaitingGrant') return;
		if (isGranted()) {
			restartAttempt = 0;
			await spawn();
			return;
		}
		if (pollTicks >= GRANT_POLL_MAX_TICKS) {
			clearTimer();
			return;
		}
		timer = setTimeout(pollTick, GRANT_POLL_INTERVAL_MS);
	}

	return {
		/**
		 * Wire the supervisor and reconcile to the current grant. Returns a cleanup
		 * to call on unmount. No-op on the browser build, where in-app keydown owns
		 * shortcuts and there is no rdev thread to supervise.
		 */
		attach(): () => void {
			if (!tauri) return () => {};
			detached = false;
			const t = tauri;
			let stoppedUnlisten: (() => void) | undefined;
			void t.globalShortcuts
				.onListenerStopped(() => void onStopped())
				.then((unlisten) => {
					if (detached) unlisten();
					else stoppedUnlisten = unlisten;
				});
			const removeFocus = on(window, 'focus', () => void onFocus());
			const removeBlur = on(window, 'blur', () => onBlur());
			// Reconcile to the seeded grant: start now if allowed, else await it.
			void onFocus();
			return () => {
				detached = true;
				clearTimer();
				removeFocus();
				removeBlur();
				stoppedUnlisten?.();
			};
		},
	};
}

export const globalListener = createGlobalListener();
