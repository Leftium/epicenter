import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Ok, tryAsync } from 'wellcrafted/result';

const WINDOW_LABEL = 'transformation-picker';

/**
 * Event names for handing the captured selection from the main window (where the
 * shortcut fires and the copy is simulated) to the picker window (a separate
 * webview, so a module variable can't cross the boundary; Tauri events can).
 *
 * - `:input` carries the captured text TO the picker window.
 * - `:ready` is the picker window asking for the input on first mount, before
 *   the main window knows it exists. The main window answers with `:input`.
 *   Re-opens skip this: the page is already mounted, so the proactive `:input`
 *   from `openWithSelection` reaches it directly.
 */
export const PICKER_INPUT_EVENT = 'transformation-picker:input';
export const PICKER_READY_EVENT = 'transformation-picker:ready';

/**
 * Feedback the picker can only deliver after it hides (clipboard copy, paste
 * failure): the main window shows it as a toast, since the picker's own toasts
 * would render in the now-hidden webview.
 */
export const PICKER_NOTICE_EVENT = 'transformation-picker:notice';

/** The most recent captured selection, replayed when the window asks for it. */
let pendingInput = '';

let responderRegistered = false;

/**
 * Answer the picker window's first-mount request with the pending selection.
 * Registered lazily from `openWithSelection`, which only the main window calls,
 * so the responder never runs inside the picker webview itself (this module is
 * imported there too, for the event-name constants and `hide`). Registering it
 * at module load would make the picker window answer its own request with an
 * empty `pendingInput` and clobber the real selection.
 */
function registerInputResponder(): void {
	if (responderRegistered) return;
	responderRegistered = true;
	void listen(PICKER_READY_EVENT, () => {
		void emit(PICKER_INPUT_EVENT, { input: pendingInput });
	});
}

/**
 * Open the transformation picker on a freshly captured selection. Creates the
 * window on first call (the page requests the input on mount), then shows and
 * re-delivers on subsequent calls. The window is hidden, not disposed, so
 * re-opening is instant.
 */
export async function openWithSelection(input: string): Promise<void> {
	registerInputResponder();
	pendingInput = input;

	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existingWindow) {
		await existingWindow.show();
		// setFocus often fails on macOS; ignore.
		await existingWindow.setFocus().catch(() => {});
		await emit(PICKER_INPUT_EVENT, { input });
		return;
	}

	const windowInstance = new WebviewWindow(WINDOW_LABEL, {
		url: '/transformation-picker',
		title: 'Transformations',
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
		console.error('Failed to create transformation picker window:', error);
	});
}

/**
 * Hides the transformation picker window (doesn't dispose it for fast
 * re-opening).
 */
export async function hide(): Promise<void> {
	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existingWindow) {
		await tryAsync({
			try: () => existingWindow.hide(),
			catch: (error) => {
				console.error('Error hiding transformation picker window:', error);
				return Ok(undefined);
			},
		});
	}
}
