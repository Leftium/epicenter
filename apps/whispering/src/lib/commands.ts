import type { ShortcutEvent } from '@tauri-apps/plugin-global-shortcut';
import {
	cancelManualRecording,
	startManualRecording,
	startVadRecording,
	stopManualRecording,
	stopVadRecording,
	toggleManualRecording,
	toggleVadRecording,
} from '$lib/operations/recording';
import {
	openTransformationPicker,
	runTransformationOnClipboard,
} from '$lib/operations/transformation-clipboard';

/**
 * Registry of available commands in the application.
 * Defines what commands exist and how they're triggered (keyboard shortcuts,
 * voice, command palette, etc.).
 *
 * The actual command implementations live in $lib/operations/* as plain async
 * functions that can be invoked from anywhere in the UI, not just through this
 * command registry.
 */

/**
 * The keyboard event state passed to callbacks.
 * Derived from Tauri's ShortcutEvent type for consistency.
 */
export type ShortcutEventState = ShortcutEvent['state'];

type SatisfiedCommand = {
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

export const commands = [
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
		id: 'startManualRecording',
		title: 'Start recording',
		on: ['Pressed'],
		callback: () => startManualRecording(),
	},
	{
		id: 'stopManualRecording',
		title: 'Stop recording',
		on: ['Pressed'],
		callback: () => stopManualRecording(),
	},
	{
		id: 'cancelManualRecording',
		title: 'Cancel recording',
		on: ['Pressed'],
		callback: () => cancelManualRecording(),
	},
	{
		id: 'startVadRecording',
		title: 'Start voice activated recording',
		on: ['Pressed'],
		callback: () => startVadRecording(),
	},
	{
		id: 'stopVadRecording',
		title: 'Stop voice activated recording',
		on: ['Pressed'],
		callback: () => stopVadRecording(),
	},
	{
		id: 'toggleVadRecording',
		title: 'Toggle voice activated recording',
		on: ['Pressed'],
		callback: () => toggleVadRecording(),
	},
	{
		id: 'openTransformationPicker',
		title: 'Open transformation picker',
		on: ['Pressed'],
		callback: () => openTransformationPicker(),
	},
	{
		id: 'runTransformationOnClipboard',
		title: 'Run transformation on clipboard',
		on: ['Pressed'],
		callback: () => runTransformationOnClipboard(),
	},
] as const satisfies SatisfiedCommand[];

export type Command = (typeof commands)[number];

type CommandCallbacks = Record<Command['id'], Command['callback']>;

export const commandCallbacks = commands.reduce<CommandCallbacks>(
	(acc, command) => {
		acc[command.id] = command.callback;
		return acc;
	},
	{} as CommandCallbacks,
);
