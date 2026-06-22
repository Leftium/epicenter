import { goto } from '$app/navigation';
import { platformCommands } from '#platform/commands';
import {
	cancelRecording,
	startManualRecording,
	stopManualRecording,
	toggleManualRecording,
	toggleVadRecording,
} from '$lib/operations/recording';
import { runTransformationOnClipboard } from '$lib/operations/transformation-clipboard';
import type { Reach } from '$lib/utils/key-binding';

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
	/** Settings section and command-palette grouping. */
	category: string;
	/** Extra command-palette search text beyond the title. */
	keywords?: string;
	/**
	 * The command's intrinsic reach ceiling: the farthest it could ever fire,
	 * fixed by its nature rather than chosen by the user. `global` (recording,
	 * cancel) is meaningful from any app; `focused` (navigation) only with
	 * Whispering in front. Required, because reach is the headline fact of a
	 * command, so it is always stated rather than defaulted; `focused` is the
	 * conservative choice for a new command. It is the first term of
	 * `realizedReach` (see {@link Reach} and ADR-0052).
	 */
	reach: Reach;
	/**
	 * When to trigger `run`.
	 * - ['Pressed']: Only on key press
	 * - ['Released']: Only on key release
	 * - ['Pressed', 'Released']: On both press and release
	 */
	on: ShortcutEventState[];
	run: (state?: ShortcutEventState) => void;
};

/** Commands available in every build (browser and desktop). */
const sharedCommands = [
	{
		id: 'pushToTalk',
		title: 'Push to talk',
		category: 'Recording',
		reach: 'global',
		// Hold to record, release to stop. Recording starts on the press and stops
		// on the release; both the desktop rdev backend and the browser keydown
		// backend emit this Pressed/Released pair. Stateless: the edges are the
		// whole state machine, so the routing is glue that lives with the command,
		// not an operation. Default global key is Fn (macOS) / Ctrl+Win (else).
		on: ['Pressed', 'Released'],
		run: (state?: ShortcutEventState) => {
			if (state === 'Pressed') return startManualRecording();
			if (state === 'Released') return stopManualRecording();
		},
	},
	{
		id: 'toggleManualRecording',
		title: 'Toggle recording',
		category: 'Recording',
		reach: 'global',
		// Tap to start, tap to stop. This is also what the in-app record button
		// fires (a click arrives with no edge). Unbound globally by default:
		// push-to-talk owns the default recording key. Bind a key here for a
		// hands-free toggle, e.g. for long-form dictation.
		on: ['Pressed'],
		run: () => toggleManualRecording(),
	},
	{
		id: 'cancelRecording',
		title: 'Cancel recording',
		category: 'Recording',
		reach: 'global',
		on: ['Pressed'],
		run: () => cancelRecording(),
	},
	{
		id: 'toggleVadRecording',
		title: 'Toggle voice activated recording',
		category: 'Recording',
		reach: 'global',
		on: ['Pressed'],
		run: () => toggleVadRecording(),
	},
	{
		id: 'runTransformationOnClipboard',
		title: 'Run transformation on clipboard',
		category: 'Transformation',
		reach: 'global',
		on: ['Pressed'],
		run: () => runTransformationOnClipboard(),
	},
	{
		id: 'openSettings',
		title: 'Open settings',
		category: 'Navigation',
		// The first focused-reach command: navigation is meaningless from another
		// app, so its reach ceiling is `focused`. A capable chord like Cmd+, cannot
		// escape that ceiling (realizedReach clamps it to focused), so it never
		// registers globally; it fires only with Whispering in front. See ADR-0052.
		reach: 'focused',
		on: ['Pressed'],
		run: () => goto('/settings'),
	},
] as const satisfies SatisfiedCommand[];

export const commands = [
	...sharedCommands,
	...platformCommands,
] as const satisfies SatisfiedCommand[];

export type Command = (typeof commands)[number];

export type CommandRunners = Record<Command['id'], Command['run']>;

export const commandRunners = commands.reduce<CommandRunners>(
	(acc, command) => {
		acc[command.id] = command.run;
		return acc;
	},
	{} as CommandRunners,
);

type TriggerTarget = {
	on: readonly ShortcutEventState[];
	run: (state?: ShortcutEventState) => void;
};
const triggerTargetById = new Map<string, TriggerTarget>(
	commands.map((c) => [c.id, { on: c.on, run: c.run }]),
);

/**
 * The single convergence point for trigger backends. The desktop rdev listener
 * and the browser keydown manager both emit raw `(commandId, edge)` pairs into
 * here, so neither reimplements the `on` filter: an edge the command does not
 * subscribe to is dropped, the rest reach the handler. Direct invocations
 * (command palette, in-app buttons) bypass this and call `commandRunners`
 * with no edge.
 */
export function dispatchCommandTrigger(
	commandId: string,
	state: ShortcutEventState,
) {
	const target = triggerTargetById.get(commandId);
	if (!target?.on.includes(state)) return;
	target.run(state);
}
