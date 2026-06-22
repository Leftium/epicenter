<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Popover from '@epicenter/ui/popover';
	import AppWindow from '@lucide/svelte/icons/app-window';
	import Globe from '@lucide/svelte/icons/globe';
	import Lock from '@lucide/svelte/icons/lock';
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
		type Reach,
		type ReachWithGrant,
	} from '$lib/utils/key-binding';
	import { createChordRecorder } from './create-chord-recorder';

	// The one router-driven recorder (ADR-0052): the user picks a key, never a
	// store. A command's two slots (focused, global) render as reach-glyphed chips,
	// and one "Add" popover captures a key while previewing, live, how far that key
	// will reach. The router routes the write by realized reach; the recorder never
	// names a store. `tauri` is passed (null on web) so the page keeps owning the
	// platform seam; the native tap capture path is gated on it.
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

	/** ADR-0052 read-only reach text, the title and screen-reader label of a glyph. */
	function reachLabel({ reach, needsAccessibility }: ReachWithGrant): string {
		if (reach === 'focused') return 'Works in Whispering';
		return needsAccessibility
			? 'Works everywhere, needs Accessibility'
			: 'Works everywhere';
	}

	let open = $state(false);
	let capturing = $state(false);
	// The combo held so far this session, so the popover can preview its reach
	// before the user releases. `null` between sessions and the instant capture
	// starts. See `create-chord-recorder`'s `onProgress`.
	let previewBinding = $state<KeyBinding | null>(null);
	const preview = $derived.by(() => {
		if (!previewBinding || isEmptyBinding(previewBinding)) return null;
		return {
			binding: previewBinding,
			realized: shortcuts.reachBadge(command.id, previewBinding),
		};
	});

	// Desktop with Accessibility granted: the native tap sees Fn and modifier-only
	// holds the webview cannot. Otherwise (web, or no grant) the webview keydown
	// recorder captures bare keys and chords; Fn and holds wait on the grant.
	const useTapCapture = $derived(!!tauri && dictationCapability.isActive);

	// Accumulated across a tap capture: the held combo, committed on release.
	let capturedModifiers = new Set<Modifier>();
	let capturedKeys = new Set<Key>();

	const chordRecorder = createChordRecorder({
		onCapture: (next) => void commitCandidate(next),
		onProgress: (partial) => {
			previewBinding = partial;
		},
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
					const accumulated: KeyBinding = {
						modifiers: [...capturedModifiers],
						keys: [...capturedKeys],
					};
					// Empty combo = everything released. Commit what we accumulated;
					// otherwise preview the held combo's reach live.
					if (
						isEmptyBinding(combo) &&
						capturedModifiers.size + capturedKeys.size > 0
					) {
						void commitCandidate(accumulated);
					} else {
						previewBinding = accumulated;
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
		previewBinding = null;
		// On desktop, tell the supervisor we are capturing so the tap spins up (gated
		// on trust) and an Fn or modifier-only binding is even recordable. On web
		// there is no tap; the webview recorder is the only brain.
		if (tauri) await tauri.keyboard.setCapturing(true);
	}

	async function stopSession() {
		if (!capturing) return;
		capturing = false;
		previewBinding = null;
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
			previewBinding = null;
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

	async function clear(reach: Reach) {
		await shortcuts.clear(command.id, reach);
	}
</script>

{#snippet reachGlyph(realized: ReachWithGrant)}
	<span
		class="inline-flex items-center text-muted-foreground"
		title={reachLabel(realized)}
	>
		{#if realized.reach === 'focused'}
			<AppWindow class="size-3.5" />
		{:else if realized.needsAccessibility}
			<Lock class="size-3.5" />
		{:else}
			<Globe class="size-3.5" />
		{/if}
		<span class="sr-only">{reachLabel(realized)}</span>
	</span>
{/snippet}

<div class="flex flex-wrap items-center justify-end gap-2">
	{#each chips as chip (chip.reach)}
		<div class="flex items-center gap-1.5">
			<Kbd.Root>{keyBindingToLabel(chip.binding, os.isApple)}</Kbd.Root>
			{@render reachGlyph(shortcuts.reachBadge(command.id, chip.binding))}
			<Button
				variant="ghost"
				size="icon"
				class="size-6 shrink-0"
				onclick={() => clear(chip.reach)}
			>
				<XIcon class="size-3.5" />
				<span class="sr-only">Clear {chip.reach} shortcut</span>
			</Button>
		</div>
	{/each}

	<Popover.Root
		{open}
		onOpenChange={(next) => {
			open = next;
			if (next) void startSession();
			else void stopSession();
		}}
	>
		<Popover.Trigger>
			<Button
				variant="ghost"
				size="sm"
				class="h-8 font-normal text-muted-foreground"
			>
				<Plus class="size-3.5" />
				<span class="text-xs">Add</span>
			</Button>
		</Popover.Trigger>

		<Popover.Content class="w-72" align="end">
			<div class="space-y-3">
				<h4 class="text-sm font-medium leading-none">{command.title}</h4>

				<div
					class="flex h-16 flex-col items-center justify-center gap-1 rounded-md border border-input bg-muted/30 px-3 text-center"
					aria-live="polite"
				>
					{#if preview}
						<div class="flex items-center gap-1.5">
							<Kbd.Root>
								{keyBindingToLabel(preview.binding, os.isApple)}
							</Kbd.Root>
							{@render reachGlyph(preview.realized)}
						</div>
						<p class="text-xs text-muted-foreground">
							{reachLabel(preview.realized)}
						</p>
					{:else}
						<p class="text-sm font-medium">Press a key</p>
						<p class="text-xs text-muted-foreground">
							A bare key works in Whispering, a chord works everywhere.
						</p>
					{/if}
				</div>

				{#if tauri && dictationCapability.needsAccessibility}
					<!-- Bare keys and chords record without permission; this is the honest
					upgrade for the Fn and modifier-only holds the webview cannot see. -->
					<p class="text-xs text-muted-foreground">
						Fn and holds need
						<button
							type="button"
							class="underline underline-offset-2 hover:text-foreground"
							onclick={() => accessibilityGuide.open()}
						>
							Accessibility
						</button>.
					</p>
				{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
</div>
