<script lang="ts">
	import { onDestroy } from 'svelte';
	import { type Command, commands } from '$lib/commands';
	import { report } from '$lib/report';
	import { type CommandId, localShortcuts } from '$lib/services/local-shortcut-manager';
	import { settings } from '$lib/state/settings.svelte';
	import { os } from '#platform/os';
	import type { KeyBinding } from '$lib/tauri/commands';
	import {
		bindingsEqual,
		keyBindingToLabel,
		keyBindingToString,
		parseManualBinding,
	} from '$lib/utils/key-binding';
	import { createChordRecorder } from './create-chord-recorder';
	import RecorderShell from './RecorderShell.svelte';

	const {
		command,
		placeholder,
	}: {
		command: Command;
		placeholder?: string;
	} = $props();

	const localKey = (id: Command['id']) => `shortcut.${id}` as const;

	const stored = $derived(settings.get(localKey(command.id)));
	const binding = $derived(stored ? parseManualBinding(stored) : null);
	const label = $derived(binding ? keyBindingToLabel(binding, os.isApple) : null);

	// Whether the recorder popover is open, and whether a capture session is
	// running inside it.
	let open = $state(false);
	let capturing = $state(false);

	const chordRecorder = createChordRecorder({
		onCapture: (next) => void commit(next),
	});

	function startSession() {
		capturing = true;
		chordRecorder.start();
	}

	function stopSession() {
		if (!capturing) return;
		capturing = false;
		chordRecorder.stop();
	}

	// If the recorder is torn down mid-capture (route change or the popover
	// dismissed by unmount), the window listeners would leak; always stop.
	onDestroy(stopSession);

	// The other command bound to the same key set, if any. The keydown matcher
	// fires every command whose set matches, so two commands sharing a set would
	// both trigger. Refuse the collision at write time, as the global recorder
	// refuses an overlapping gesture.
	function conflictingCommand(next: KeyBinding): Command | null {
		for (const other of commands) {
			if (other.id === command.id) continue;
			const otherStored = settings.get(localKey(other.id));
			const otherBinding = otherStored ? parseManualBinding(otherStored) : null;
			if (otherBinding && bindingsEqual(otherBinding, next)) return other;
		}
		return null;
	}

	// Register the binding with the matcher and store it as the readable grammar.
	async function persist(next: KeyBinding) {
		const { error } = await localShortcuts.registerCommand({
			command,
			binding: next,
		});
		if (error) {
			report.error({ title: 'Error registering local shortcut', cause: error });
			return;
		}
		settings.set(localKey(command.id), keyBindingToString(next));
		report.success({
			title: `Local shortcut set to ${keyBindingToLabel(next, os.isApple)}`,
			description: `Press the shortcut to trigger "${command.title}"`,
		});
	}

	// On a clean capture: refuse a collision (stay listening so the user can retry),
	// otherwise persist and close.
	async function commit(next: KeyBinding) {
		const conflict = conflictingCommand(next);
		if (conflict) {
			report.error({
				title: 'That shortcut is already in use',
				description: `Those keys already trigger "${conflict.title}". Pick a different combination.`,
				cause: {
					name: 'DuplicateLocalShortcut',
					message: `${keyBindingToLabel(next, os.isApple)} is bound to "${conflict.title}".`,
				},
			});
			return;
		}
		await persist(next);
		stopSession();
		open = false;
	}

	function submitManual(raw: string): boolean {
		const next = parseManualBinding(raw);
		if (!next) {
			report.error({
				title: 'Invalid shortcut',
				description: 'Try e.g. ctrl+shift+a, space, or a single key like f5.',
				cause: {
					name: 'InvalidManualShortcut',
					message: `"${raw}" is not a valid combination.`,
				},
			});
			return false;
		}
		const conflict = conflictingCommand(next);
		if (conflict) {
			report.error({
				title: 'That shortcut is already in use',
				description: `Those keys already trigger "${conflict.title}". Pick a different combination.`,
				cause: {
					name: 'DuplicateLocalShortcut',
					message: `${keyBindingToLabel(next, os.isApple)} is bound to "${conflict.title}".`,
				},
			});
			return false;
		}
		void persist(next).then(() => {
			stopSession();
			open = false;
		});
		return true;
	}

	async function clear() {
		stopSession();
		const { error } = await localShortcuts.unregisterCommand({
			commandId: command.id as CommandId,
		});
		if (error) {
			report.error({ title: 'Error clearing local shortcut', cause: error });
		}
		settings.set(localKey(command.id), null);
		report.success({
			title: 'Local shortcut cleared',
			description: `Please set a new shortcut to trigger "${command.title}"`,
		});
	}

	const recorder = {
		get isListening() {
			return capturing;
		},
		get label() {
			return label;
		},
		get manualInitial() {
			return stored ?? '';
		},
		start: startSession,
		stop: stopSession,
		clear: () => void clear(),
		submitManual,
	};
</script>

<RecorderShell
	bind:open
	title={command.title}
	{recorder}
	copy={{
		placeholder,
		recordHelp: 'Click to record or edit manually',
		manualHelp: 'Enter shortcut manually (e.g., ctrl+shift+a)',
		manualPlaceholder: 'e.g., ctrl+shift+a',
		manualButtonLabel: 'Edit manually',
		listeningHint: 'Release to set, Esc to cancel',
	}}
/>
