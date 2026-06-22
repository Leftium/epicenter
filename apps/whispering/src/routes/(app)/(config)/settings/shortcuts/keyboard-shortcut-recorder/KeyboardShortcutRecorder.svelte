<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { onDestroy } from 'svelte';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import type { Command } from '$lib/commands';
	import { os } from '#platform/os';
	import type { Tauri } from '#platform/tauri';
	import type { RoutedShortcuts } from '$lib/platform/reach-router';
	import { report } from '$lib/report';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';
	import {
		isEmptyBinding,
		keyBindingToLabel,
		parseManualBinding,
		type Reach,
		type ReachWithGrant,
	} from '$lib/utils/key-binding';
	import { createChordRecorder } from './create-chord-recorder';

	// The one router-driven recorder (ADR-0052): the user picks a key, never a
	// store. A command's two slots (focused, global) render as reach-badged chips,
	// and one "Add" popover captures a key and lets the router route the write by
	// realized reach. This replaces the old Local/Global split, where the page
	// chose the store per platform. `tauri` is passed (null on web) so the page
	// keeps owning the platform seam; the tap capture path is gated on it.
	const {
		command,
		shortcuts,
		tauri,
	}: {
		command: Command;
		shortcuts: RoutedShortcuts;
		tauri: Tauri | null;
	} = $props();

	// At most one focused and one global binding per command, so up to two chips.
	const bindings = $derived(shortcuts.current(command.id));
	const chips = $derived(
		(['focused', 'global'] as const)
			.map((reach) => ({ reach, binding: bindings[reach] }))
			.filter(
				(slot): slot is { reach: Reach; binding: KeyBinding } =>
					slot.binding !== null && !isEmptyBinding(slot.binding),
			),
	);

	/** ADR-0052 read-only badge text for a realized reach. */
	function reachLabel({ reach, needsAccessibility }: ReachWithGrant): string {
		if (reach === 'focused') return 'Works in Whispering';
		return needsAccessibility
			? 'Works everywhere, needs Accessibility'
			: 'Works everywhere';
	}

	let open = $state(false);
	let capturing = $state(false);
	let isManualMode = $state(false);
	let manualValue = $state('');

	// Desktop with Accessibility granted: the native tap sees Fn and modifier-only
	// holds the webview cannot. Otherwise (web, or no grant) the webview keydown
	// recorder captures bare keys and chords; Fn and holds wait on the grant.
	const useTapCapture = $derived(!!tauri && dictationCapability.isActive);

	// Accumulated across a tap capture: the held combo, committed on release.
	let capturedModifiers = new Set<Modifier>();
	let capturedKeys = new Set<Key>();

	const chordRecorder = createChordRecorder({
		onCapture: (next) => void commitCandidate(next),
	});

	// Exactly one capture brain runs at a time, chosen by trust. If trust flips
	// while the session is open (the user grants Accessibility), this tears down
	// the old brain and starts the right one with no reopen.
	$effect(() => {
		if (!capturing) return;
		if (tauri && useTapCapture) {
			const desktop = tauri;
			capturedModifiers = new Set();
			capturedKeys = new Set();
			// `listenForCapture` resolves async; if trust flips and this effect tears
			// down before it does, detach the moment it lands so the listener cannot
			// leak (the pattern dictation-capability.svelte.ts uses for the same race).
			let torn = false;
			let unlisten: (() => void) | undefined;
			void desktop.keyboard
				.listenForCapture((combo) => {
					for (const modifier of combo.modifiers)
						capturedModifiers.add(modifier);
					for (const key of combo.keys) capturedKeys.add(key);
					// Empty combo = everything released. Commit what we accumulated.
					if (
						isEmptyBinding(combo) &&
						capturedModifiers.size + capturedKeys.size > 0
					) {
						void commitCandidate({
							modifiers: [...capturedModifiers],
							keys: [...capturedKeys],
						});
					}
				})
				.then((fn) => {
					if (torn) fn();
					else unlisten = fn;
				});
			return () => {
				torn = true;
				unlisten?.();
			};
		}
		chordRecorder.start();
		return () => chordRecorder.stop();
	});

	async function startSession() {
		if (capturing) return;
		capturing = true;
		// On desktop, tell the supervisor we are capturing so the tap spins up (gated
		// on trust) and an Fn or modifier-only binding is even recordable. On web
		// there is no tap; the webview recorder is the only brain.
		if (tauri) await tauri.keyboard.setCapturing(true);
	}

	async function stopSession() {
		if (!capturing) return;
		capturing = false;
		if (tauri) await tauri.keyboard.setCapturing(false);
	}

	// If the recorder is torn down mid-capture (route change, or the popover
	// dismissed by unmount), nothing else leaves capture mode; always end it.
	onDestroy(() => {
		if (capturing) void stopSession();
	});

	// The router checks the conflict against the store the key would route into,
	// so the per-tier policy (focused refuses duplicates; global refuses reserved
	// gestures and overlaps) matches where the binding will live. Returns true when
	// refused.
	function rejectConflict(next: KeyBinding): boolean {
		const reason = shortcuts.findConflict(command.id, next);
		if (!reason) return false;
		report.error({
			title: 'That shortcut is not available',
			description: reason,
			cause: {
				name: 'ShortcutConflict',
				message: `${keyBindingToLabel(next, os.isApple)}: ${reason}`,
			},
		});
		return true;
	}

	// Persist a captured key, routed by realized reach: a bare key lands in-app, a
	// chord goes global on desktop, a hold goes global behind Accessibility. The
	// recorder never names a store; the key's reach decides. On a conflict it stays
	// listening so the user can retry without reopening.
	async function commitCandidate(next: KeyBinding) {
		if (rejectConflict(next)) {
			capturedModifiers = new Set();
			capturedKeys = new Set();
			return;
		}
		const realized = shortcuts.reachBadge(command.id, next);
		await shortcuts.set(command.id, next);
		report.success({
			title: `${command.title} set to ${keyBindingToLabel(next, os.isApple)}`,
			description: reachLabel(realized),
		});
		await stopSession();
		open = false;
	}

	function submitManual(raw: string): boolean {
		const next = parseManualBinding(raw);
		if (!next) {
			report.error({
				title: 'Invalid shortcut',
				description: 'Try e.g. ctrl+shift+a, space, or fn+space.',
				cause: {
					name: 'InvalidManualShortcut',
					message: `"${raw}" is not a valid combination.`,
				},
			});
			return false;
		}
		if (rejectConflict(next)) return false;
		void commitCandidate(next);
		return true;
	}

	function enterManualMode() {
		isManualMode = true;
		manualValue = '';
		void stopSession();
	}

	async function clear(reach: Reach) {
		await shortcuts.clear(command.id, reach);
	}

	const recordHelp = $derived(
		useTapCapture
			? 'Press any key or gesture. Fn and holds work here.'
			: tauri
				? 'Press a key or chord. Fn and holds need Accessibility (see above).'
				: 'Press a key or chord.',
	);
</script>

<svelte:window
	onkeydown={(e) => {
		// Escape cancels an in-progress capture without committing.
		if (capturing && e.key === 'Escape') {
			e.preventDefault();
			void stopSession();
		}
	}}
/>

<div class="flex flex-wrap items-center justify-end gap-2">
	{#each chips as chip (chip.reach)}
		<div class="flex items-center gap-1">
			<Kbd.Root>{keyBindingToLabel(chip.binding, os.isApple)}</Kbd.Root>
			<span class="text-xs text-muted-foreground">
				{reachLabel(shortcuts.reachBadge(command.id, chip.binding))}
			</span>
			<Button
				variant="ghost"
				size="icon"
				class="size-6 shrink-0"
				onclick={() => clear(chip.reach)}
			>
				<XIcon class="size-3" />
				<span class="sr-only">Clear {chip.reach} shortcut</span>
			</Button>
		</div>
	{:else}
		<span class="text-sm text-muted-foreground">Not set</span>
	{/each}

	<Popover.Root
		{open}
		onOpenChange={(next) => {
			open = next;
			if (!next) {
				void stopSession();
				isManualMode = false;
			}
			if (next && !isManualMode) {
				void startSession();
			}
		}}
	>
		<Popover.Trigger>
			<Button variant="ghost" size="sm" class="h-8 font-normal">
				<Plus class="size-3" />
				<span class="text-xs text-muted-foreground">Add</span>
			</Button>
		</Popover.Trigger>

		<Popover.Content
			class="w-80"
			align="end"
			onEscapeKeydown={(e) => {
				if (capturing) e.preventDefault();
			}}
		>
			<div class="space-y-4">
				<div>
					<h4 class="mb-1 text-sm font-medium leading-none">{command.title}</h4>
					<p class="text-xs text-muted-foreground">
						{isManualMode
							? 'Enter a shortcut manually (e.g. ctrl+shift+a, space, fn+space)'
							: recordHelp}
					</p>
				</div>

				{#if tauri && dictationCapability.needsAccessibility && !isManualMode}
					<!-- Chords and bare keys record without permission; this is the honest
					upgrade for the Fn and modifier-only holds the webview cannot see. -->
					<Alert.Root variant="warning" class="text-xs">
						<AlertTriangle class="size-4" />
						<Alert.Title class="text-xs font-medium">
							Fn and holds need Accessibility
						</Alert.Title>
						<Alert.Description class="space-y-2 text-xs">
							<p>
								Bare keys and chords record here without any permission. To record
								Fn push-to-talk or a modifier-only hold, grant macOS Accessibility.
							</p>
							<Button
								variant="outline"
								size="sm"
								onclick={() => accessibilityGuide.open()}
							>
								Enable Accessibility
							</Button>
						</Alert.Description>
					</Alert.Root>
				{/if}

				{#if !isManualMode}
					<button
						type="button"
						class={cn(
							'relative flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
							capturing && 'ring-2 ring-ring ring-offset-2',
						)}
						onclick={() => void startSession()}
						aria-label={capturing
							? 'Recording keyboard shortcut'
							: 'Click to record keyboard shortcut'}
					>
						<div class="flex w-full items-center justify-between">
							<span class="truncate text-muted-foreground">
								{capturing ? '' : 'Press a key combination'}
							</span>
							{#if !capturing}
								<Keyboard class="size-4 text-muted-foreground" />
							{/if}
						</div>

						{#if capturing}
							<div
								class="absolute inset-0 z-10 flex animate-in fade-in-0 zoom-in-95 items-center justify-center rounded-md border border-input bg-background/95 backdrop-blur-sm"
								aria-live="polite"
							>
								<div class="flex flex-col items-center gap-1 px-4 py-2">
									<p class="text-sm font-medium">Press key combination</p>
									<p class="text-xs text-muted-foreground">Release to set, Esc to cancel</p>
								</div>
							</div>
						{/if}
					</button>

					<Button
						variant="outline"
						size="sm"
						class="w-full"
						onclick={enterManualMode}
					>
						<Pencil class="size-3" />
						Enter manually
					</Button>
				{:else}
					<form
						onsubmit={(e) => {
							e.preventDefault();
							if (!manualValue) return;
							if (submitManual(manualValue) !== false) isManualMode = false;
						}}
						class="space-y-3"
					>
						<Input
							type="text"
							placeholder="e.g. ctrl+shift+a"
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
							<Button
								type="submit"
								size="sm"
								class="flex-1"
								disabled={!manualValue}
							>
								Save
							</Button>
						</div>
					</form>
				{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
</div>
