import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Ok, tryAsync } from 'wellcrafted/result';

const WINDOW_LABEL = 'transform-clipboard';

/**
 * Event names for handing the captured selection from the main window (where the
 * shortcut fires and the copy is simulated) to the Polish window (a separate
 * webview, so a module variable can't cross the boundary; Tauri events can).
 *
 * - `polish:input` carries the captured text TO the Polish window.
 * - `polish:ready` is the Polish window asking for the input on first mount,
 *   before the main window knows it exists. The main window answers with
 *   `polish:input`. Re-opens skip this: the page is already mounted, so the
 *   proactive `polish:input` from `openWithSelection` reaches it directly.
 */
export const POLISH_INPUT_EVENT = 'polish:input';
export const POLISH_READY_EVENT = 'polish:ready';

/** The most recent captured selection, replayed when the window asks for it. */
let pendingInput = '';

let responderRegistered = false;

/**
 * Answer the Polish window's first-mount request with the pending selection.
 * Registered lazily from `openWithSelection`, which only the main window calls,
 * so the responder never runs inside the Polish webview itself (this module is
 * imported there too, for the event-name constants and `hide`). Registering it
 * at module load would make the Polish window answer its own request with an
 * empty `pendingInput` and clobber the real selection.
 */
function registerInputResponder(): void {
	if (responderRegistered) return;
	responderRegistered = true;
	void listen(POLISH_READY_EVENT, () => {
		void emit(POLISH_INPUT_EVENT, { input: pendingInput });
	});
}

/**
 * Open the Polish window on a freshly captured selection. Creates the window on
 * first call (the page requests the input on mount), then shows and re-delivers
 * on subsequent calls. The window is hidden, not disposed, so re-opening is
 * instant.
 */
export async function openWithSelection(input: string): Promise<void> {
	registerInputResponder();
	pendingInput = input;

	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existingWindow) {
		await existingWindow.show();
		// setFocus often fails on macOS; ignore.
		await existingWindow.setFocus().catch(() => {});
		await emit(POLISH_INPUT_EVENT, { input });
		return;
	}

	const windowInstance = new WebviewWindow(WINDOW_LABEL, {
		url: '/transform-clipboard',
		title: 'Polish',
		width: 700,
		height: 600,
		center: true,
		alwaysOnTop: true,
		decorations: true,
		resizable: true,
		focus: true,
		visible: true,
	});

	windowInstance.once('tauri://error', (error) => {
		console.error('Failed to create Polish window:', error);
	});
}

/**
 * Hides the Polish window (doesn't dispose it for fast re-opening).
 */
export async function hide(): Promise<void> {
	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existingWindow) {
		await tryAsync({
			try: () => existingWindow.hide(),
			catch: (error) => {
				console.error('Error hiding Polish window:', error);
				return Ok(undefined);
			},
		});
	}
}
