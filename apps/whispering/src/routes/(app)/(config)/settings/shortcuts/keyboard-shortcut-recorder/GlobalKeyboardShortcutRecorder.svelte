<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import Pencil from '@lucide/svelte/icons/pencil';
	import XIcon from '@lucide/svelte/icons/x';
	import type { Command } from '$lib/commands';
	import { report } from '$lib/report';
	import type { Tauri } from '#platform/tauri';
	import { syncGlobalShortcutsWithSettings } from '$routes/(app)/_layout-utils/register-commands';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';
	import { os } from '#platform/os';
	import {
		isEmptyBinding,
		keyBindingToLabel,
		parseManualBinding,
	} from '$lib/utils/key-binding';

	// `tauri` is passed non-null from the Tauri-gated global settings page; the
	// recorder drives the rdev backend through it. Recording goes through rdev
	// (not webview keydown) so it can capture the Fn key and physical positions.
	const {
		command,
		placeholder = 'Press a key combination',
		autoFocus = true,
		tauri,
	}: {
		command: Command;
		placeholder?: string;
		autoFocus?: boolean;
		tauri: Tauri;
	} = $props();

	const binding = $derived(deviceConfig.get(`shortcuts.global.${command.id}`));
	const label = $derived(binding ? keyBindingToLabel(binding, os.isApple) : null);

	let isPopoverOpen = $state(false);
	let isManualMode = $state(false);
	let isListening = $state(false);
	let manualValue = $state('');

	// Accumulate the union of every combo the listener reports during a capture,
	// then commit when all keys release (mirrors the old recorder's behavior,
	// sourced from rdev instead of the webview).
	let capturedModifiers = new Set<Modifier>();
	let capturedKeys = new Set<Key>();
	let unlisten: (() => void) | undefined;

	async function startCapture() {
		isListening = true;
		capturedModifiers = new Set();
		capturedKeys = new Set();
		await tauri.globalShortcuts.setCapturing(true);
		unlisten = await tauri.globalShortcuts.listenForCapture((combo) => {
			for (const modifier of combo.modifiers) capturedModifiers.add(modifier);
			for (const key of combo.keys) capturedKeys.add(key);
			// Empty combo = everything released. Commit what we accumulated.
			if (isEmptyBinding(combo) && capturedModifiers.size + capturedKeys.size > 0) {
				void commitCapture();
			}
		});
	}

	async function stopCapture() {
		isListening = false;
		unlisten?.();
		unlisten = undefined;
		await tauri.globalShortcuts.setCapturing(false);
	}

	async function commitCapture() {
		const next: KeyBinding = {
			modifiers: [...capturedModifiers],
			keys: [...capturedKeys],
		};
		await stopCapture();
		await persist(next);
		isPopoverOpen = false;
	}

	async function persist(next: KeyBinding) {
		deviceConfig.set(`shortcuts.global.${command.id}`, next);
		await syncGlobalShortcutsWithSettings();
		report.success({
			title: `Global shortcut set to ${keyBindingToLabel(next, os.isApple)}`,
			description: `Press the shortcut to trigger "${command.title}"`,
		});
	}

	async function clear() {
		await stopCapture();
		deviceConfig.set(`shortcuts.global.${command.id}`, null);
		await syncGlobalShortcutsWithSettings();
		report.success({
			title: 'Global shortcut cleared',
			description: `Set a new shortcut to trigger "${command.title}"`,
		});
	}

	function submitManual() {
		const next = parseManualBinding(manualValue);
		if (!next) {
			report.error({
				title: 'Invalid shortcut',
				description:
					'Try e.g. cmd+shift+d, fn+space, or a modifier-only hold like cmd.',
				cause: {
					name: 'InvalidManualShortcut',
					message: `"${manualValue}" is not a valid combination.`,
				},
			});
			return;
		}
		isManualMode = false;
		void persist(next).then(() => {
			isPopoverOpen = false;
		});
	}
</script>

<svelte:window
	onkeydown={(e) => {
		// Escape cancels an in-progress capture without committing.
		if (isListening && e.key === 'Escape') {
			e.preventDefault();
			void stopCapture();
		}
	}}
/>

<div class="flex items-center justify-end gap-2">
	{#if label}
		<Kbd.Root>{label}</Kbd.Root>
		<Button
			variant="ghost"
			size="icon"
			class="size-8 shrink-0"
			onclick={() => clear()}
		>
			<XIcon class="size-4" />
			<span class="sr-only">Clear shortcut</span>
		</Button>
	{:else}
		<span class="text-sm text-muted-foreground">Not set</span>
	{/if}

	<Popover.Root
		open={isPopoverOpen}
		onOpenChange={(open) => {
			isPopoverOpen = open;
			if (!open) {
				void stopCapture();
				isManualMode = false;
			}
			if (open && autoFocus && !isManualMode) {
				void startCapture();
			}
		}}
	>
		<Popover.Trigger>
			<Button variant="ghost" size="sm" class="h-8 font-normal">
				{#if label}
					<span class="text-xs">Set shortcut</span>
				{:else}
					<span class="text-xs text-muted-foreground">+ Add</span>
				{/if}
			</Button>
		</Popover.Trigger>

		<Popover.Content
			class="w-80"
			align="end"
			onEscapeKeydown={(e) => {
				if (isListening) e.preventDefault();
			}}
		>
			<div class="space-y-4">
				<div>
					<h4 class="mb-1 text-sm font-medium leading-none">{command.title}</h4>
					<p class="text-xs text-muted-foreground">
						{#if isManualMode}
							Type a combination (e.g. cmd+shift+d, fn+space)
						{:else}
							Press a combination. Fn and modifier-only holds work here.
						{/if}
					</p>
				</div>

				{#if !isManualMode}
					<button
						type="button"
						class={cn(
							'relative flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
							isListening && 'ring-2 ring-ring ring-offset-2',
						)}
						onclick={() => void startCapture()}
						tabindex="0"
						aria-label={isListening
							? 'Recording keyboard shortcut'
							: 'Click to record keyboard shortcut'}
					>
						<div class="flex w-full items-center justify-between">
							<div class="flex grow items-center gap-1.5 pr-2">
								{#if label && !isListening}
									<Kbd.Root>{label}</Kbd.Root>
								{:else if !isListening}
									<span class="truncate text-muted-foreground">{placeholder}</span>
								{/if}
							</div>
							{#if !isListening}
								<Keyboard class="size-4 text-muted-foreground" />
							{/if}
						</div>

						{#if isListening}
							<div
								class="absolute inset-0 z-10 flex animate-in fade-in-0 zoom-in-95 items-center justify-center rounded-md border border-input bg-background/95 backdrop-blur-sm"
								aria-live="polite"
							>
								<div class="flex flex-col items-center gap-1 px-4 py-2">
									<p class="text-sm font-medium">Press key combination</p>
									<p class="text-xs text-muted-foreground">
										Release to set, Esc to cancel
									</p>
								</div>
							</div>
						{/if}
					</button>

					<div class="flex items-center gap-2">
						{#if label}
							<Button
								variant="outline"
								size="sm"
								class="flex-1"
								onclick={() => clear()}
							>
								<XIcon class="size-3" />
								Clear
							</Button>
						{/if}
						<Button
							variant="outline"
							size="sm"
							class={label ? 'flex-1' : 'w-full'}
							onclick={() => {
								isManualMode = true;
								manualValue = label ?? '';
								void stopCapture();
							}}
						>
							<Pencil class="size-3" />
							Type manually
						</Button>
					</div>
				{:else}
					<form
						onsubmit={(e) => {
							e.preventDefault();
							submitManual();
						}}
						class="space-y-3"
					>
						<Input
							type="text"
							placeholder="e.g. cmd+shift+d"
							bind:value={manualValue}
							class="font-mono text-sm"
							autofocus
						/>
						<div class="flex items-center gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								class="flex-1"
								onclick={() => {
									isManualMode = false;
								}}
							>
								Cancel
							</Button>
							<Button type="submit" size="sm" class="flex-1" disabled={!manualValue}>
								Save
							</Button>
						</div>
					</form>
				{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
</div>
