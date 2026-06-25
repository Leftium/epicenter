<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import XIcon from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';
	import LevelMeter from '$lib/components/LevelMeter.svelte';
	import VadIndicator from '$lib/recording-overlay/VadIndicator.svelte';
	import { webPillLevel } from '$lib/recording-overlay/web-pill.svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { tauri } from '#platform/tauri';
	import type { RecordingActionController } from './recording-action-controller';

	// The controller owns the state machine and every derived label/icon. The card
	// only decides presentation: a spinner while pending, the destructive "filled"
	// treatment while active, and a footer shown only at rest.
	let {
		controller,
		footer,
		iconViewTransitionName,
	}: {
		controller: RecordingActionController;
		footer?: Snippet;
		/**
		 * When set, names the action glyph for a cross-page view transition while
		 * the card is at rest. Suppressed automatically while `active`, because the
		 * live glyph (a stop square, a waveform) is a different object and must not
		 * morph from the resting mode glyph. Callers pass the name unconditionally;
		 * the card owns the at-rest gate.
		 */
		iconViewTransitionName?: string;
	} = $props();

	const accessibleLabel = $derived(
		controller.shortcutLabel
			? `${controller.label} (${controller.shortcutLabel})`
			: controller.label,
	);

	// Exactly one live meter shows at a time, on the surface holding your
	// attention. On desktop the always-on-top overlay is that meter: it floats over
	// even the focused app for the whole recording, so the card defers to it with a
	// static glyph and a second meter here would only double the overlay's. On web
	// there is no floating overlay, so the in-window surface carries the meter: this
	// card on the home route (where the in-page pill stands down), the pill on the
	// other routes. The smoothed level is already in this window on web
	// (`webPillLevel`); on desktop it is emitted straight to the overlay, not here.
	const showsLiveMeter = !tauri;
</script>

<div
	class={cn(
		'w-full overflow-hidden rounded-lg border border-border/70 bg-card/60 text-foreground shadow-sm ring-1 ring-foreground/5 transition-[background-color,border-color,box-shadow,color] duration-200 hover:border-primary/55 hover:bg-card/75 hover:shadow-md hover:ring-primary/25',
		controller.active &&
			'border-destructive/45 bg-card/70 hover:border-destructive/60 hover:bg-destructive/10 hover:ring-destructive/25',
	)}
>
	<Button
		aria-label={accessibleLabel}
		aria-pressed={controller.active}
		aria-busy={controller.pending}
		tooltip={controller.tooltip}
		disabled={controller.pending}
		onclick={controller.toggle}
		variant="ghost"
		class={cn(
			'min-h-24 w-full justify-start gap-3 rounded-none bg-transparent px-3.5 py-3.5 text-left hover:bg-card/70 sm:gap-4 sm:px-4',
			controller.pending && 'cursor-wait',
		)}
	>
		<span
			aria-hidden="true"
			class={cn(
				'relative flex size-14 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/70 text-foreground shadow-inner transition-colors duration-200 sm:size-16',
				controller.active &&
					'border-destructive/45 bg-destructive/10 text-destructive',
			)}
		>
			{#if controller.pending}
				<Spinner class="size-7" />
			{:else if controller.active && showsLiveMeter}
				<!-- Live capture: the glyph slot becomes the meter, the same bars the
				floating pill draws, scaled to fit the box. -->
				<LevelMeter
					level={webPillLevel.level}
					class="gap-[2px]"
					barClass="w-[2px] bg-destructive"
					minPx={3}
					maxPx={28}
				/>
				{#if controller.vad}
					<!-- VAD session: the same dim-dot -> lit-dot -> spinner indicator the
					floating pill shows beside its meter, here in the glyph's corner. The
					bars track loudness; this dot tracks whether VAD has latched onto speech
					and becomes a spinner while a previous phrase is still transcribing. On
					'/' the pill yields the recording phase to this card, so this is the
					only place that last signal shows. The signals come from this card's own
					controller (present only for VAD), not a global lookup. -->
					<span
						class="absolute top-0.5 right-0.5 flex size-4 items-center justify-center"
					>
						<VadIndicator
							signals={controller.vad}
							dimClass="bg-destructive/40"
							litClass="bg-destructive"
							spinnerClass="text-muted-foreground"
						/>
					</span>
				{/if}
			{:else}
				{@const Icon = controller.icon}
				<span
					class="inline-flex"
					style:view-transition-name={controller.active
						? undefined
						: iconViewTransitionName}
				>
					<Icon
						class={cn(
							'size-7',
							controller.active && 'size-6 fill-current stroke-[1.75]',
						)}
					/>
				</span>
			{/if}
		</span>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="truncate text-base font-semibold leading-none sm:text-lg">
				{controller.label}
			</span>
			<span class="truncate text-xs font-medium text-muted-foreground sm:text-sm">
				{controller.description}
			</span>
		</span>
		{#if controller.shortcutLabel}
			<!-- On desktop the shortcut is the global rdev tap, which only fires when
			the capability is active. Keep showing the key but dim it whenever the tap
			can't fire (macOS Accessibility ungranted or stale, or Linux Wayland),
			reading the same fact the home-page notice does so the two agree. -->
			<Kbd.Root
				class={cn(
					'h-7 max-w-28 shrink-0 rounded-md bg-muted/75 px-2 text-xs text-muted-foreground shadow-none',
					dictationCapability.isUnavailable && 'opacity-50',
				)}
			>
				{controller.shortcutLabel}
			</Kbd.Root>
		{/if}
	</Button>

	<!-- The footer slot is the card's secondary zone: at rest it configures the
	pipeline; while live it discards the take. Keeping the slot filled in both
	states keeps the discard control tethered to the card (not orphaned below it)
	and holds the card's height steady across start/stop. VAD has no discard, so
	its live footer is empty and the slot collapses. -->
	{#if controller.active}
		{#if controller.cancel}
			<div
				class="flex justify-center border-t border-border/60 bg-background/20 px-3 py-2"
			>
				<Button
					tooltip="Cancel recording and discard audio"
					onclick={() => controller.cancel?.()}
					variant="ghost-destructive"
					size="sm"
				>
					<XIcon class="size-4" />
					Cancel recording
				</Button>
			</div>
		{/if}
	{:else if footer}
		<div class="border-t border-border/60 bg-background/20 px-3 py-2">
			{@render footer()}
		</div>
	{/if}
</div>
