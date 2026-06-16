import {
	cancelRecording,
	startManualRecording,
	stopManualRecording,
	toggleManualRecording,
	toggleVadRecording,
} from '$lib/operations/recording';
import { runTransformationOnClipboard } from '$lib/operations/transformation-clipboard';
import { platformCommands } from '#platform/commands';

/**
 * Registry of available commands in the application.
 * Defines what commands exist and how they're triggered (keyboard shortcuts,
 * voice, command palette, etc.).
 *
 * The actual command implementations live in $lib/operations/* as plain async
 * functions that can be invoked from anywhere in the UI, not just through this
 * command registry.
 *
 * Platform split: `sharedCommands` exist in every build. Desktop-only commands
 * (the transformation picker, which captures a selection from another app and
 * opens a Tauri window) come from the `#platform/commands` seam, so a browser
 * build never imports their Tauri-only code and never offers them as shortcuts.
 */

/**
 * The keyboard event state passed to callbacks: a trigger backend reports
 * either the press or the release edge. Both the desktop rdev backend (which
 * emits the generated `TriggerState`) and the browser keydown backend speak
 * this exact pair, so the command layer is the single point where they
 * converge.
 */
export type ShortcutEventState = 'Pressed' | 'Released';

export type SatisfiedCommand = {
	id: string;
	title: string;
	/**
	 * When to trigger the callback.
	 * - ['Pressed']: Only on key press
	 * - ['Released']: Only on key release
	 * - ['Pressed', 'Released']: On both press and release
	 */
	on: ShortcutEventState[];
	callback: (state?: ShortcutEventState) => void;
};

/** Commands available in every build (browser and desktop). */
const sharedCommands = [
	{
		id: 'pushToTalk',
		title: 'Push to talk',
		on: ['Pressed', 'Released'],
		callback: (state?: ShortcutEventState) => {
			if (state === 'Pressed') {
				startManualRecording();
			} else if (state === 'Released') {
				stopManualRecording();
			}
		},
	},
	{
		id: 'toggleManualRecording',
		title: 'Toggle recording',
		on: ['Pressed'],
		callback: () => toggleManualRecording(),
	},
	{
		id: 'cancelRecording',
		title: 'Cancel recording',
		on: ['Pressed'],
		callback: () => cancelRecording(),
	},
	{
		id: 'toggleVadRecording',
		title: 'Toggle voice activated recording',
		on: ['Pressed'],
		callback: () => toggleVadRecording(),
	},
	{
		id: 'runTransformationOnClipboard',
		title: 'Run transformation on clipboard',
		on: ['Pressed'],
		callback: () => runTransformationOnClipboard(),
	},
] as const satisfies SatisfiedCommand[];

export const commands = [
	...sharedCommands,
	...platformCommands,
] as const satisfies SatisfiedCommand[];

export type Command = (typeof commands)[number];

export type CommandCallbacks = Record<Command['id'], Command['callback']>;

export const commandCallbacks = commands.reduce<CommandCallbacks>(
	(acc, command) => {
		acc[command.id] = command.callback;
		return acc;
	},
	{} as CommandCallbacks,
);
