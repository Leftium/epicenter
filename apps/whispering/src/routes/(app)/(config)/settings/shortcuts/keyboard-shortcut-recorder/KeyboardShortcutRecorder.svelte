<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Popover from '@epicenter/ui/popover';
	import AppWindow from '@lucide/svelte/icons/app-window';
	import Globe from '@lucide/svelte/icons/globe';
	import Lock from '@lucide/svelte/icons/lock';
	import Plus from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import type { Command } from '$lib/commands';
	import { os } from '#platform/os';
	import { tauri } from '#platform/tauri';
	import { shortcuts } from '$lib/platform/shortcuts';
	import { report } from '$lib/report';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import type { KeyBinding } from '$lib/tauri/commands';
	import {
		isEmptyBinding,
		keyBindingToLabel,
		type Reach,
		type ReachWithGrant,
	} from '$lib/utils/key-binding';
	import { createChordRecorder } from './create-chord-recorder';
	import { createTapRecorder } from './create-tap-recorder';

	// The one router-driven recorder (ADR-0052): the user picks a key, never a
	// store. A command's two slots (focused, global) render as reach-glyphed chips,
	// and one "Add" popover captures a key while previewing, live, how far that key
	// will reach. The router (`shortcuts`) routes the write by realized reach; the
	// recorder never names a store. `tauri` is the platform seam (null on web); the
	// native tap capture path is gated on it.
	const { command }: { command: Command } = $props();

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

	// ADR-0052 read-only reach text: where the shortcut fires, plus whether it syncs
	// (focused shortcuts live in the synced workspace; global ones are per-device).
	// One string feeds the glyph tooltip, the live preview, and the success toast.
	function reachLabel({ reach, needsAccessibility }: ReachWithGrant): string {
		if (reach === 'focused')
			return 'Works in Whispering, synced across your devices';
		return needsAccessibility
			? 'Works everywhere on this computer, needs Accessibility'
			: 'Works everywhere on this computer';
	}

	// The popover's open state is the whole session: open means listening. The two
	// never diverge, so there is no separate `capturing` flag to keep in sync.
	let open = $state(false);
	// The combo held so far this session, so the popover can preview its reach
	// before the user releases. `null` between sessions. See each recorder's
	// `onProgress`.
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

	// The desktop keyboard handle, resolved once (the platform seam never changes).
	// `null` on web, where there is no native tap and no capture supervisor.
	const keyboard = tauri?.keyboard ?? null;

	// Two capture brains, one interface. The owner picks one by trust and never
	// touches accumulation; each calls back with the held combo (onProgress) and
	// the committed gesture (onCapture).
	const onCapture = (next: KeyBinding) => void commitCandidate(next);
	const onProgress = (partial: KeyBinding) => {
		previewBinding = partial;
	};
	const chordRecorder = createChordRecorder({ onCapture, onProgress });
	const tapRecorder = keyboard
		? createTapRecorder({ keyboard, onCapture, onProgress })
		: null;

	// On desktop, tell the supervisor we are capturing for the session's lifetime,
	// so the tap engages the moment Accessibility is granted. The cleanup runs on
	// close and on unmount, so capture can never strand on.
	$effect(() => {
		if (!open || !keyboard) return;
		void keyboard.setCapturing(true);
		return () => void keyboard.setCapturing(false);
	});

	// Exactly one brain runs while open, chosen by trust. If trust flips mid-session
	// (the user grants Accessibility), this swaps brains with no reopen.
	$effect(() => {
		if (!open) return;
		const recorder = useTapCapture && tapRecorder ? tapRecorder : chordRecorder;
		recorder.start();
		return () => recorder.stop();
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
		// On a conflict, stay open and listening so the user can retry; each recorder
		// has already reset its own accumulation.
		if (rejectConflict(next)) {
			previewBinding = null;
			return;
		}
		const realized = shortcuts.reachBadge(command.id, next);
		await shortcuts.set(command.id, next);
		report.success({
			title: `${command.title} set to ${keyBindingToLabel(next, os.isApple)}`,
			description: reachLabel(realized),
		});
		// Closing tears capture down through the effects' cleanup.
		previewBinding = null;
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

{#snippet keyChip(binding: KeyBinding, realized: ReachWithGrant)}
	<Kbd.Root>{keyBindingToLabel(binding, os.isApple)}</Kbd.Root>
	{@render reachGlyph(realized)}
{/snippet}

<div class="flex flex-wrap items-center justify-end gap-2">
	{#each chips as chip (chip.reach)}
		<div class="flex items-center gap-1.5">
			{@render keyChip(
				chip.binding,
				shortcuts.reachBadge(command.id, chip.binding),
			)}
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
			if (!next) previewBinding = null;
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
							{@render keyChip(preview.binding, preview.realized)}
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
