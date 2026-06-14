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
	// owns the popover / record / manual-entry *UI* only; each recorder owns its
	// own capture brain (webview keydown vs the rdev backend) and passes its
	// state plus callbacks in. The markup lives here once so the two recorders
	// cannot drift; the capture logic stays out so they remain decoupled across
	// the #platform seam.
	let {
		open = $bindable(false),
		title,
		placeholder = 'Press a key combination',
		autoFocus = true,
		label,
		isListening,
		onStart,
		onStop,
		onClear,
		onManualSubmit,
		manualInitial = '',
		recordHelp,
		manualHelp,
		manualPlaceholder,
		manualButtonLabel,
		listeningHint = 'Esc to cancel',
		warning,
	}: {
		open?: boolean;
		title: string;
		placeholder?: string;
		autoFocus?: boolean;
		/** Display label of the current binding, or null when unset. */
		label: string | null;
		isListening: boolean;
		onStart: () => void;
		onStop: () => void;
		onClear: () => void;
		/** Returns false to stay in manual mode (e.g. invalid input). */
		onManualSubmit: (raw: string) => boolean | void;
		manualInitial?: string;
		recordHelp: string;
		manualHelp: string;
		manualPlaceholder: string;
		manualButtonLabel: string;
		listeningHint?: string;
		warning?: Snippet;
	} = $props();

	let isManualMode = $state(false);
	let manualValue = $state('');

	function enterManualMode() {
		isManualMode = true;
		manualValue = manualInitial;
		onStop();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		// Escape cancels an in-progress capture without committing.
		if (isListening && e.key === 'Escape') {
			e.preventDefault();
			onStop();
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
			onclick={() => onClear()}
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
				onStop();
				isManualMode = false;
			}
			if (next && autoFocus && !isManualMode) {
				onStart();
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
					<h4 class="mb-1 text-sm font-medium leading-none">{title}</h4>
					<p class="text-xs text-muted-foreground">
						{isManualMode ? manualHelp : recordHelp}
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
							isListening && 'ring-2 ring-ring ring-offset-2',
						)}
						onclick={() => onStart()}
						tabindex="0"
						aria-label={isListening
							? 'Recording keyboard shortcut'
							: 'Click to record keyboard shortcut'}
					>
						<div class="flex w-full items-center justify-between">
							<div
								class="flex grow items-center gap-1.5 overflow-x-auto pr-2 scrollbar-none"
							>
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
									<p class="text-xs text-muted-foreground">{listeningHint}</p>
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
								onclick={() => onClear()}
							>
								<XIcon class="size-3" />
								Clear
							</Button>
						{/if}
						<Button
							variant="outline"
							size="sm"
							class={label ? 'flex-1' : 'w-full'}
							onclick={enterManualMode}
						>
							<Pencil class="size-3" />
							{manualButtonLabel}
						</Button>
					</div>
				{:else}
					<form
						onsubmit={(e) => {
							e.preventDefault();
							if (!manualValue) return;
							if (onManualSubmit(manualValue) !== false) isManualMode = false;
						}}
						class="space-y-3"
					>
						<Input
							type="text"
							placeholder={manualPlaceholder}
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
