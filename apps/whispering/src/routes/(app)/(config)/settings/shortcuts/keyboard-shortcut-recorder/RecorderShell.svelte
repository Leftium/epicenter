<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import Pencil from '@lucide/svelte/icons/pencil';
	import XIcon from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';

	// Presentational shell shared by the Local and Global shortcut recorders. It
	// owns the popover / record / manual-entry *UI* only. Each recorder owns its
	// own capture brain (webview keydown vs the rdev backend) and hands it in as
	// the `recorder` object, so the markup lives here once and the two recorders
	// cannot drift while staying decoupled across the #platform seam.
	let {
		open = $bindable(false),
		title,
		recorder,
		copy,
		warning,
	}: {
		open?: boolean;
		title: string;
		/**
		 * The capture brain. Local adapts its `keyRecorder`; Global builds one
		 * from the rdev backend. Reactive fields must be getters so the shell
		 * re-renders as capture state changes.
		 */
		recorder: {
			isListening: boolean;
			/** Display label of the current binding, or null when unset. */
			label: string | null;
			/** Raw value to prefill manual-edit mode with. */
			manualInitial: string;
			start: () => void;
			stop: () => void;
			clear: () => void;
			/** Returns false to stay in manual mode (e.g. invalid input). */
			submitManual: (raw: string) => boolean | void;
		};
		/** Per-recorder display strings. */
		copy: {
			placeholder?: string;
			recordHelp: string;
			manualHelp: string;
			manualPlaceholder: string;
			manualButtonLabel: string;
			listeningHint?: string;
		};
		warning?: Snippet;
	} = $props();

	let isManualMode = $state(false);
	let manualValue = $state('');

	function enterManualMode() {
		isManualMode = true;
		manualValue = recorder.manualInitial;
		recorder.stop();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		// Escape cancels an in-progress capture without committing.
		if (recorder.isListening && e.key === 'Escape') {
			e.preventDefault();
			recorder.stop();
		}
	}}
/>

<div class="flex items-center justify-end gap-2">
	{#if recorder.label}
		<Kbd.Root>{recorder.label}</Kbd.Root>
		<Button
			variant="ghost"
			size="icon"
			class="size-8 shrink-0"
			onclick={() => recorder.clear()}
		>
			<XIcon class="size-4" />
			<span class="sr-only">Clear shortcut</span>
		</Button>
	{:else}
		<span class="text-sm text-muted-foreground">Not set</span>
	{/if}

	<Popover.Root
		{open}
		onOpenChange={(next) => {
			open = next;
			if (!next) {
				recorder.stop();
				isManualMode = false;
			}
			if (next && !isManualMode) {
				recorder.start();
			}
		}}
	>
		<Popover.Trigger>
			<Button variant="ghost" size="sm" class="h-8 font-normal">
				{#if recorder.label}
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
				if (recorder.isListening) e.preventDefault();
			}}
		>
			<div class="space-y-4">
				<div>
					<h4 class="mb-1 text-sm font-medium leading-none">{title}</h4>
					<p class="text-xs text-muted-foreground">
						{isManualMode ? copy.manualHelp : copy.recordHelp}
					</p>
				</div>

				{#if warning && !isManualMode}
					{@render warning()}
				{/if}

				{#if !isManualMode}
					<button
						type="button"
						class={cn(
							'relative flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
							recorder.isListening && 'ring-2 ring-ring ring-offset-2',
						)}
						onclick={() => recorder.start()}
						tabindex="0"
						aria-label={recorder.isListening
							? 'Recording keyboard shortcut'
							: 'Click to record keyboard shortcut'}
					>
						<div class="flex w-full items-center justify-between">
							<div
								class="flex grow items-center gap-1.5 overflow-x-auto pr-2 scrollbar-none"
							>
								{#if recorder.label && !recorder.isListening}
									<Kbd.Root>{recorder.label}</Kbd.Root>
								{:else if !recorder.isListening}
									<span class="truncate text-muted-foreground"
										>{copy.placeholder ?? 'Press a key combination'}</span
									>
								{/if}
							</div>
							{#if !recorder.isListening}
								<Keyboard class="size-4 text-muted-foreground" />
							{/if}
						</div>

						{#if recorder.isListening}
							<div
								class="absolute inset-0 z-10 flex animate-in fade-in-0 zoom-in-95 items-center justify-center rounded-md border border-input bg-background/95 backdrop-blur-sm"
								aria-live="polite"
							>
								<div class="flex flex-col items-center gap-1 px-4 py-2">
									<p class="text-sm font-medium">Press key combination</p>
									<p class="text-xs text-muted-foreground">
										{copy.listeningHint ?? 'Esc to cancel'}
									</p>
								</div>
							</div>
						{/if}
					</button>

					<div class="flex items-center gap-2">
						{#if recorder.label}
							<Button
								variant="outline"
								size="sm"
								class="flex-1"
								onclick={() => recorder.clear()}
							>
								<XIcon class="size-3" />
								Clear
							</Button>
						{/if}
						<Button
							variant="outline"
							size="sm"
							class={recorder.label ? 'flex-1' : 'w-full'}
							onclick={enterManualMode}
						>
							<Pencil class="size-3" />
							{copy.manualButtonLabel}
						</Button>
					</div>
				{:else}
					<form
						onsubmit={(e) => {
							e.preventDefault();
							if (!manualValue) return;
							if (recorder.submitManual(manualValue) !== false)
								isManualMode = false;
						}}
						class="space-y-3"
					>
						<Input
							type="text"
							placeholder={copy.manualPlaceholder}
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
