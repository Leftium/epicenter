/**
 * Owns the desktop shortcut backend: device-local binding sync, rdev listener
 * liveness, trigger stream dispatch, and platform status notices.
 */

import { on } from 'svelte/events';
import { createSubscriber } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { os } from '#platform/os';
import { goto } from '$app/navigation';
import { dispatchCommandTrigger, type Command, commands } from '$lib/commands';
import { report } from '$lib/report';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { permissions } from '$lib/state/permissions.svelte';
import type { CommandBinding, KeyBinding } from '$lib/tauri/commands';
import { tauriOnly } from '$lib/tauri.tauri';
import { keyBindingToLabel } from '$lib/utils/key-binding';
import type { ShortcutBackendStatus, Shortcuts } from './types';

/**
 * Desktop build of `#platform/shortcuts`: system-global gestures driven by the
 * rdev backend, stored in device-config under `shortcuts.global.*` (never
 * synced across devices). Defaults are read back through device-config so the
 * backend and schema share one source of truth.
 */

const globalKey = (id: Command['id']) => `shortcuts.global.${id}` as const;
const STOPPED_NOTICE_ID = 'global-shortcuts-stopped';
const WAYLAND_NOTICE_ID = 'wayland-unsupported';

// Backoff for an unexpected death while the grant still holds, so a genuinely
// broken tap cannot hot-loop. After the last step we give up to a standing
// notice. A death more than the reset window after the previous one starts with
// a fresh budget, because there is no positive "stayed alive" signal to reset on.
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RESTART_RESET_WINDOW_MS = 60_000;

// Bounded grant poll. It runs only while we are blurred and awaiting the grant:
// the only way to grant Accessibility is in System Settings, which blurs us, and
// a toggle that lands while Settings holds focus would otherwise go unseen until
// we tab back. Focus stops the poll, so this never becomes a steady-state timer.
const GRANT_POLL_INTERVAL_MS = 1_000;
const GRANT_POLL_MAX_TICKS = 60;

let status: ShortcutBackendStatus = 'idle';
let notifyStatus = () => {};
const subscribeStatus = createSubscriber((update) => {
	notifyStatus = update;
	return () => {
		notifyStatus = () => {};
	};
});

function setStatus(next: ShortcutBackendStatus) {
	status = next;
	notifyStatus();
}

let restartAttempt = 0;
let lastStopAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let detached = true;

function clearTimer() {
	if (timer) clearTimeout(timer);
	timer = undefined;
}

/** macOS is the only platform with a real gate; elsewhere the grant is free. */
function isGranted(): boolean {
	return !os.isApple || permissions.accessibilityGranted;
}

/** Canonical string for a binding, so structurally-equal bindings dedupe. */
function bindingKey(binding: {
	modifiers: readonly string[];
	keys: readonly string[];
}): string {
	return JSON.stringify({
		modifiers: [...binding.modifiers].sort(),
		keys: [...binding.keys].sort(),
	});
}

async function sync(): Promise<void> {
	const bindings: CommandBinding[] = [];
	for (const command of commands) {
		const binding = deviceConfig.get(globalKey(command.id));
		if (!binding) continue;
		// Storage validates keys as plain strings; Rust validates them by name on
		// register. The cast bridges the stored `string[]` to the IPC `Key[]`.
		bindings.push({ commandId: command.id, binding: binding as KeyBinding });
	}
	// Keys are validated by Rust at the IPC boundary, so a single bad key fails
	// the whole replace-all call. Surface it instead of silently unregistering.
	const { error } = await tryAsync({
		try: () => tauriOnly.globalShortcuts.setBindings(bindings),
		catch: (cause) =>
			Err({
				name: 'GlobalShortcutRegistrationFailed',
				message: extractErrorMessage(cause),
			}),
	});
	if (error) {
		report.error({ title: 'Error registering global shortcuts', cause: error });
	}
}

function reset(): void {
	for (const command of commands) {
		deviceConfig.set(
			globalKey(command.id),
			deviceConfig.getDefault(globalKey(command.id)),
		);
	}
	void sync();
}

function resetIfDuplicates(): boolean {
	const seen = new Map<string, string>();
	for (const command of commands) {
		const binding = deviceConfig.get(globalKey(command.id));
		if (!binding) continue;
		const key = bindingKey(binding);
		if (seen.has(key)) {
			reset();
			report.success({
				title: 'Shortcuts reset',
				description:
					'Duplicate global shortcuts detected. All global shortcuts have been reset to defaults.',
				action: {
					label: 'Configure shortcuts',
					onClick: () => goto('/settings/shortcuts'),
				},
			});
			return true;
		}
		seen.set(key, command.id);
	}
	return false;
}

function defaultLabel(commandId: Command['id']): string {
	const binding = deviceConfig.getDefault(globalKey(commandId));
	return binding ? keyBindingToLabel(binding, os.isApple) : '';
}

/**
 * Spawn the rdev thread (idempotent in Rust) and assume it is alive until a
 * stop event says otherwise. Wayland reports `unsupported` instead.
 */
async function spawn() {
	if (detached) return;
	const result = await tauriOnly.globalShortcuts.start();
	if (detached) return;
	if (result === 'waylandUnsupported') {
		setStatus('unsupported');
		clearTimer();
		report.warning({
			id: WAYLAND_NOTICE_ID,
			title: 'Global shortcuts unavailable on Wayland',
			description:
				'Whispering needs an X11 session for global shortcuts. On Wayland, bind them through your desktop environment.',
		});
		return;
	}
	setStatus('running');
	report.dismiss(STOPPED_NOTICE_ID);
}

/** macOS denied: sit and wait. The poll is armed by blur, not here. */
function awaitGrant() {
	setStatus('awaitingGrant');
	clearTimer();
}

/**
 * The rdev thread exited. Re-probe to learn why, then reconcile: a vanished
 * grant drops us back to waiting; a grant that still holds restarts with capped
 * backoff and, once the cap is spent, surfaces one standing notice.
 */
async function onStopped() {
	if (detached) return;
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
		setStatus('degraded');
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
	setStatus('recovering');
	clearTimer();
	timer = setTimeout(() => void spawn(), delay);
}

/**
 * Window regained focus, or we are reconciling at launch. The focus re-probe is
 * the reliable grant sampler, so it stops any in-flight poll and decides:
 * granted means start with a fresh budget; denied means wait for the next blur.
 */
async function onFocus() {
	if (detached || status === 'running' || status === 'unsupported') return;
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
 * Window lost focus while awaiting the grant: the user is likely in System
 * Settings toggling Accessibility now. Arm the bounded poll so the flip lands
 * live, since no focus event fires while Settings holds focus.
 */
function onBlur() {
	if (detached || status !== 'awaitingGrant' || timer) return;
	let ticks = 0;
	const tick = async () => {
		ticks += 1;
		await permissions.refresh();
		if (detached || status !== 'awaitingGrant') return;
		if (isGranted()) {
			restartAttempt = 0;
			await spawn();
			return;
		}
		if (ticks >= GRANT_POLL_MAX_TICKS) {
			clearTimer();
			return;
		}
		timer = setTimeout(tick, GRANT_POLL_INTERVAL_MS);
	};
	timer = setTimeout(tick, GRANT_POLL_INTERVAL_MS);
}

export const shortcuts: Shortcuts = {
	get status() {
		subscribeStatus();
		return status;
	},
	attach() {
		detached = false;
		void sync();
		resetIfDuplicates();
		let stoppedUnlisten: (() => void) | undefined;
		let triggerUnlisten: (() => void) | undefined;
		void tauriOnly.globalShortcuts
			.onListenerStopped(() => void onStopped())
			.then((unlisten) => {
				if (detached) unlisten();
				else stoppedUnlisten = unlisten;
			});
		void tauriOnly.globalShortcuts
			.startListening(dispatchCommandTrigger)
			.then((unlisten) => {
				if (detached) unlisten();
				else triggerUnlisten = unlisten;
			});
		const removeFocus = on(window, 'focus', () => void onFocus());
		const removeBlur = on(window, 'blur', () => onBlur());
		void onFocus();
		return () => {
			detached = true;
			setStatus('idle');
			clearTimer();
			removeFocus();
			removeBlur();
			stoppedUnlisten?.();
			triggerUnlisten?.();
		};
	},
	sync,
	reset,
	resetIfDuplicates,
	defaultLabel,
};
