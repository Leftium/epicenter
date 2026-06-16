import type { SatisfiedCommand } from '$lib/commands';
import { openTransformationPicker } from '$lib/operations/transformation-picker';

/**
 * Desktop-only commands, spread into the registry by the `#platform/commands`
 * seam on Tauri builds. Keeping the picker here (rather than in the shared
 * `commands.ts`) is what stops a browser build from importing the Tauri-only
 * picker window and from offering a shortcut that can only error on the web.
 */
export const platformCommands = [
	{
		id: 'openTransformationPicker',
		title: 'Open transformation picker',
		// Fire on release, not press: the global accelerator carries a Cmd/Ctrl+Shift
		// chord, and acting on the press synthesizes Cmd/Ctrl+C while that chord is
		// still held, so the foreground app sees Cmd+Shift+C instead of a clean copy.
		// `dispatchCommandTrigger` forwards only the edges named in `on`, so a
		// release-only subscription is enough: the press edge never reaches the
		// callback, and this command is desktop-only (the rdev backend is its sole
		// trigger source), so there is no in-app keydown path to account for.
		on: ['Released'],
		callback: () => openTransformationPicker(),
	},
] as const satisfies SatisfiedCommand[];
