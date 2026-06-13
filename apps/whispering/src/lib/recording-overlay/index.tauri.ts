import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	currentMonitor,
	LogicalPosition,
	primaryMonitor,
} from '@tauri-apps/api/window';
import { createLogger } from 'wellcrafted/logger';
import {
	RECORDING_OVERLAY_MIC_LEVEL,
	RECORDING_OVERLAY_READY,
	RECORDING_OVERLAY_STATUS,
	type RecordingOverlayStatus,
} from '$lib/recording-overlay/events';

const log = createLogger('whispering/recording-overlay');

const WINDOW_LABEL = 'recording-overlay';
// Fixed size in logical pixels. Matches the pill drawn by the overlay route.
const OVERLAY_WIDTH = 184;
const OVERLAY_HEIGHT = 40;
// Distance from the bottom edge of the monitor, in logical pixels.
const OVERLAY_BOTTOM_MARGIN = 72;

/**
 * Manages the floating recording overlay window from the main window.
 *
 * The overlay window is created lazily on first show and then kept alive and
 * toggled visible/hidden, mirroring the transform-clipboard window. It is
 * transparent, undecorated, always-on-top, non-focusable, and skips the
 * taskbar so it reads as a system HUD rather than an app window.
 *
 * `sync` is the only entry point: pass the status to show, or `null` to hide.
 * Calls are coalesced. Each call bumps a generation counter and runs on a
 * serial queue, and every async step re-checks the generation. The final
 * intent always wins: a burst of rapid state changes (start then immediately
 * cancel) settles on the last status, and a stale show that loses the race to
 * a later hide is collapsed rather than left visible.
 *
 * macOS note: `focusable: false` + `alwaysOnTop` keeps the overlay from
 * stealing keyboard focus in practice, but it is not a hard guarantee across
 * Spaces and fullscreen apps. A native `NSPanel` (via tauri-nspanel) is the
 * escalation path if that behavior proves insufficient; see
 * docs/recording-overlay.md.
 */

let generation = 0;
let latestStatus: RecordingOverlayStatus | null = null;
let queue: Promise<void> = Promise.resolve();
let readyListenerRegistered: Promise<void> | null = null;

async function computeOverlayPosition(): Promise<LogicalPosition | null> {
	// Prefer the monitor the main window is on; fall back to the primary.
	const monitor = (await currentMonitor()) ?? (await primaryMonitor());
	if (!monitor) return null;

	const scale = monitor.scaleFactor;
	const monitorX = monitor.position.x / scale;
	const monitorY = monitor.position.y / scale;
	const monitorWidth = monitor.size.width / scale;
	const monitorHeight = monitor.size.height / scale;

	const x = monitorX + (monitorWidth - OVERLAY_WIDTH) / 2;
	const y = monitorY + monitorHeight - OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN;
	return new LogicalPosition(x, y);
}

/**
 * Listen for the overlay's `ready` handshake and re-send whatever status is
 * current. The returned promise is cached and awaited before the window is
 * created, so the listener is guaranteed live before the overlay can emit
 * `ready`; otherwise the handshake could land in the gap between window
 * creation and listener registration and be lost. Caching the promise (not a
 * boolean flag) also prevents a duplicate listener if two creations race.
 */
function ensureReadyListener(): Promise<void> {
	readyListenerRegistered ??= listen(RECORDING_OVERLAY_READY, () => {
		if (latestStatus) void emit(RECORDING_OVERLAY_STATUS, latestStatus);
	}).then(() => undefined);
	return readyListenerRegistered;
}

async function createOverlayWindow(): Promise<WebviewWindow | null> {
	await ensureReadyListener();
	const position = await computeOverlayPosition();

	const overlay = new WebviewWindow(WINDOW_LABEL, {
		url: '/recording-overlay',
		title: 'Recording',
		width: OVERLAY_WIDTH,
		height: OVERLAY_HEIGHT,
		x: position?.x,
		y: position?.y,
		transparent: true,
		decorations: false,
		shadow: false,
		alwaysOnTop: true,
		visibleOnAllWorkspaces: true,
		skipTaskbar: true,
		resizable: false,
		maximizable: false,
		minimizable: false,
		// User can't close it; visibility is driven entirely by recorder state.
		closable: false,
		// Never take focus from the app the user is dictating into.
		focus: false,
		focusable: false,
		// Created hidden; the first `show()` reveals it once positioned.
		visible: false,
	});

	return new Promise<WebviewWindow | null>((resolve) => {
		overlay.once('tauri://created', () => resolve(overlay));
		overlay.once('tauri://error', (event) => {
			log.warn(
				new Error(
					`Failed to create recording overlay window: ${JSON.stringify(event.payload)}`,
				),
			);
			resolve(null);
		});
	});
}

async function getOrCreateOverlayWindow(): Promise<WebviewWindow | null> {
	// getByLabel is the source of truth: it survives this module's state being
	// torn down by a hot reload and detects a window closed out from under us.
	const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existing) return existing;
	return createOverlayWindow();
}

async function applyStatus(
	status: RecordingOverlayStatus | null,
	myGeneration: number,
) {
	const isStale = () => myGeneration !== generation;
	if (isStale()) return;

	if (!status) {
		const overlay = await WebviewWindow.getByLabel(WINDOW_LABEL);
		if (overlay) await overlay.hide();
		return;
	}

	const overlay = await getOrCreateOverlayWindow();
	if (!overlay || isStale()) return;

	const position = await computeOverlayPosition();
	if (isStale()) return;
	if (position) await overlay.setPosition(position);
	if (isStale()) return;

	await overlay.show();
	if (isStale()) {
		// A newer sync superseded us mid-show. The queued task will run next,
		// but if the latest intent is "hidden" we hide now to collapse the
		// brief show-then-hide flicker rather than wait for it.
		if (!latestStatus) await overlay.hide();
		return;
	}

	await emit(RECORDING_OVERLAY_STATUS, status);
}

/**
 * Show the overlay with the given status, or hide it when passed `null`.
 * Fire-and-forget: failures are logged, never thrown, because the overlay is
 * cosmetic and must not break the recording flow.
 */
function sync(status: RecordingOverlayStatus | null): void {
	latestStatus = status;
	const myGeneration = ++generation;
	queue = queue
		.then(() => applyStatus(status, myGeneration))
		.catch((error) => {
			log.warn(error instanceof Error ? error : new Error(String(error)));
		});
}

/**
 * Forward a live mic level (raw RMS) to the overlay. Targeted emit to the
 * overlay window only (not a global broadcast) since this fires ~30x/sec while
 * recording. No-op cost if the overlay is not open. Used for VAD, whose audio
 * lives in JS; manual recording's level is emitted from the Rust CPAL worker
 * straight to the same channel.
 */
function reportLevel(level: number): void {
	// Fire-and-forget and swallow: this fires ~30x/sec, and at the very start of
	// a session it can race ahead of the overlay window existing. A missed level
	// frame is invisible, so a rejected emit must never surface as an unhandled
	// rejection.
	void emitTo(WINDOW_LABEL, RECORDING_OVERLAY_MIC_LEVEL, level).catch(() => {});
}

export const recordingOverlay = { sync, reportLevel };
