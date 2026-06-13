<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Empty from '@epicenter/ui/empty';
	import { Kbd } from '@epicenter/ui/kbd';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { type Candidate, fanOutCandidates } from '$lib/operations/candidates';
	import { persistCompletedRun } from '$lib/operations/transform';
	import { sound } from '$lib/operations/sound';
	import { report } from '$lib/report';
	import { services } from '$lib/services';
	import { transformations } from '$lib/state/transformations.svelte';
	import CandidateCards from '$lib/components/CandidateCards.svelte';
	import * as pickerWindow from './transformationPickerWindow.tauri';

	// The captured selection, handed over by the main window after the shortcut
	// simulates a copy. Empty until the first input event arrives.
	let input = $state('');
	// Which transformations are toggled on; bound to the chip row.
	let activeIds = $state<string[]>([]);
	// One candidate per active transformation, kept in memory; never persisted
	// until accept. Toggling a chip adds or removes its candidate.
	let candidates = $state<Candidate[]>([]);
	let selectedIndex = $state(0);

	let unlistenInput: UnlistenFn | null = null;

	onMount(async () => {
		unlistenInput = await listen<{ input: string }>(
			pickerWindow.PICKER_INPUT_EVENT,
			(event) => receiveInput(event.payload.input),
		);
		// Tell the main window we're mounted so it replays the pending selection;
		// covers the first open, before the main window knows this webview exists.
		await emit(pickerWindow.PICKER_READY_EVENT);
	});

	onDestroy(() => unlistenInput?.());

	// Each open starts fresh over the newly captured selection.
	function receiveInput(text: string) {
		input = text;
		activeIds = [];
		candidates = [];
		selectedIndex = 0;
	}

	// Reconcile candidates to the toggled set, preserving the promises of chips
	// that stayed on so they don't re-run; new chips fan out one candidate each.
	function reconcile(ids: string[]) {
		const existing = new Map(candidates.map((c) => [c.transformation.id, c]));
		candidates = ids.flatMap((id) => {
			const kept = existing.get(id);
			if (kept) return [kept];
			const transformation = transformations.get(id);
			if (!transformation) return [];
			return fanOutCandidates({
				input,
				transformations: [transformation],
				samples: 1,
			});
		});
		selectedIndex = Math.min(selectedIndex, Math.max(0, candidates.length - 1));
	}

	async function accept() {
		const candidate = candidates[selectedIndex];
		if (!candidate) return;

		const result = await candidate.result;
		if (result.error) {
			report.error({ title: 'That result failed', cause: result.error });
			return;
		}
		const output = result.data;

		// Commit the one run before touching focus, then hand the text back to the
		// source app: hide first so focus returns to it, then paste. The other
		// candidates were in memory and are discarded.
		persistCompletedRun({
			transformationId: candidate.transformation.id,
			input: candidate.input,
			output,
			startedAt: new Date().toISOString(),
		});
		void sound.playSoundIfEnabled('transformationComplete');

		await pickerWindow.hide();
		await new Promise((resolve) => setTimeout(resolve, 120));

		const { error: writeError } = await services.text.writeToCursor(output);
		if (writeError) {
			// Can't paste (web, or no accessibility permission): leave it on the
			// clipboard so the user can paste it themselves.
			await services.text.copyToClipboard(output);
		}
	}

	async function dismiss() {
		await pickerWindow.hide();
	}

	async function manageTransformations() {
		await dismiss();
		await emit('navigate-main-window', { path: '/transformations' });
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			void dismiss();
			return;
		}
		if (!candidates.length) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, candidates.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (event.key === 'Enter') {
			// When a chip is focused, let Enter toggle it instead of accepting.
			const active = document.activeElement;
			if (active?.closest('[data-slot="toggle-group-item"]')) return;
			event.preventDefault();
			void accept();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-screen flex-col gap-4 p-6">
	<header class="flex flex-none items-start justify-between gap-2">
		<div class="space-y-1">
			<h2 class="text-2xl font-semibold tracking-tight">Transformations</h2>
			<p class="text-sm text-muted-foreground">
				Toggle transformations to run on your selection, then accept a result
			</p>
		</div>
		<Button variant="ghost" size="sm" onclick={manageTransformations}>
			Manage
		</Button>
	</header>

	<!-- The captured selection, the anchor every result is diffed against. -->
	<Card.Root class="flex-none gap-0 border-dashed bg-muted/30 py-3">
		<Card.Header class="gap-0 px-4 pb-1">
			<Card.Title
				class="text-[0.7rem] font-medium tracking-wider text-muted-foreground uppercase"
			>
				Your selection
			</Card.Title>
		</Card.Header>
		<Card.Content class="px-4">
			<p class="max-h-28 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
				{input}
			</p>
		</Card.Content>
	</Card.Root>

	{#if transformations.sorted.length === 0}
		<Empty.Root class="flex-1 border-0">
			<Empty.Title>No transformations yet</Empty.Title>
			<Empty.Description>
				Create one to run it on your selection.
			</Empty.Description>
			<Empty.Content>
				<Button size="sm" onclick={manageTransformations}>
					Create a transformation
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<ToggleGroup.Root
			type="multiple"
			bind:value={activeIds}
			onValueChange={reconcile}
			class="flex flex-none flex-wrap justify-start gap-2"
		>
			{#each transformations.sorted as transformation (transformation.id)}
				<ToggleGroup.Item
					value={transformation.id}
					class="rounded-md border-0 bg-muted px-4 text-muted-foreground hover:bg-muted/70 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
				>
					{transformation.title || 'Untitled transformation'}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>

		{#if candidates.length === 0}
			<div class="flex flex-1 items-center justify-center">
				<p class="text-sm text-muted-foreground">
					Toggle a transformation above to see results.
				</p>
			</div>
		{:else}
			<CandidateCards {candidates} original={input} bind:selectedIndex onaccept={accept} />
			<footer
				class="flex flex-none items-center gap-4 border-t pt-3 text-xs text-muted-foreground"
			>
				<span class="flex items-center gap-1">
					<Kbd>&uarr;</Kbd><Kbd>&darr;</Kbd>
					navigate
				</span>
				<span class="flex items-center gap-1"><Kbd>Enter</Kbd> accept</span>
				<span class="flex items-center gap-1"><Kbd>Esc</Kbd> dismiss</span>
			</footer>
		{/if}
	{/if}
</div>
