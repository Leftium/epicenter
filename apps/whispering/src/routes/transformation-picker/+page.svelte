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
			return fanOutCandidates({ input, transformations: [transformation] });
		});
		selectedIndex = Math.min(selectedIndex, Math.max(0, candidates.length - 1));
	}

	// Toggle a transformation by id (the number-key path); the chip row reflects
	// `activeIds` via its binding, and reconcile fans out / drops its candidate.
	function toggleTransformation(id: string) {
		activeIds = activeIds.includes(id)
			? activeIds.filter((x) => x !== id)
			: [...activeIds, id];
		reconcile(activeIds);
	}

	/**
	 * Accept the highlighted candidate. `paste` replaces the selection in the
	 * source app (the default) and leaves the clipboard untouched; `copy` puts the
	 * result on the clipboard instead. Either way exactly one run is committed.
	 * Feedback for the post-hide path is emitted to the main window, since this
	 * window hides before the clipboard/paste step.
	 */
	async function accept(mode: 'paste' | 'copy') {
		const candidate = candidates[selectedIndex];
		if (!candidate) return;

		const result = await candidate.result;
		if (result.error) {
			report.error({ title: 'That result failed', cause: result.error });
			return;
		}
		const output = result.data;

		persistCompletedRun({
			transformationId: candidate.transformation.id,
			input: candidate.input,
			output,
			startedAt: new Date().toISOString(),
		});
		void sound.playSoundIfEnabled('transformationComplete');

		if (mode === 'copy') {
			await services.text.copyToClipboard(output);
			await pickerWindow.hide();
			await notifyMainWindow({
				title: 'Copied to clipboard',
				description: 'Press Cmd+V to paste it where you want.',
			});
			return;
		}

		// Paste: hide first so focus returns to the source app, then paste.
		await pickerWindow.hide();
		await new Promise((resolve) => setTimeout(resolve, 120));

		const { error: writeError } = await services.text.writeToCursor(output);
		if (writeError) {
			// Couldn't paste (no Accessibility permission, or web): fall back to the
			// clipboard so the result is never lost, and say so.
			await services.text.copyToClipboard(output);
			await notifyMainWindow({
				title: "Couldn't paste into the app",
				description: 'Your result is on the clipboard. Press Cmd+V to paste it.',
			});
		}
	}

	function notifyMainWindow(notice: { title: string; description: string }) {
		return emit(pickerWindow.PICKER_NOTICE_EVENT, notice);
	}

	async function dismiss() {
		await pickerWindow.hide();
	}

	async function manageTransformations() {
		await dismiss();
		await emit('navigate-main-window', { path: '/transformations' });
	}

	// Capture phase so the picker owns these keys before the chips' bits-ui roving
	// focus can grab the arrows. Numbers address the chips (inputs); arrows and
	// Enter address the candidate cards (outputs); the two never overlap.
	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			void dismiss();
			return;
		}

		// 1-9 toggle the Nth transformation. `event.code` (Digit1..Digit9) ignores
		// Shift/layout (so Shift+1 isn't "!"). Bare digits only; let Cmd+digit etc.
		// fall through to the OS.
		const digit = digitFromCode(event.code);
		if (digit !== null && !event.metaKey && !event.ctrlKey && !event.altKey) {
			const transformation = transformations.sorted[digit - 1];
			if (transformation) {
				event.preventDefault();
				event.stopPropagation();
				toggleTransformation(transformation.id);
			}
			return;
		}

		if (!candidates.length) return;

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			event.stopPropagation();
			selectedIndex = Math.min(selectedIndex + 1, candidates.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			void accept(event.metaKey ? 'copy' : 'paste');
		}
	}

	function digitFromCode(code: string): number | null {
		const match = /^Digit([1-9])$/.exec(code);
		return match ? Number(match[1]) : null;
	}
</script>

<svelte:window onkeydowncapture={onKeydown} />

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
			{#each transformations.sorted as transformation, index (transformation.id)}
				<ToggleGroup.Item
					value={transformation.id}
					class="gap-1.5 rounded-md border-0 bg-muted px-4 text-muted-foreground hover:bg-muted/70 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
				>
					{#if index < 9}
						<span class="text-xs tabular-nums opacity-50">{index + 1}</span>
					{/if}
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
			<CandidateCards
				{candidates}
				original={input}
				bind:selectedIndex
				onaccept={() => accept('paste')}
			/>
			<footer
				class="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground"
			>
				<span class="flex items-center gap-1">
					<Kbd>1</Kbd>-<Kbd>9</Kbd> run
				</span>
				<span class="flex items-center gap-1">
					<Kbd>&uarr;</Kbd><Kbd>&darr;</Kbd> pick
				</span>
				<span class="flex items-center gap-1"><Kbd>&crarr;</Kbd> paste</span>
				<span class="flex items-center gap-1"><Kbd>&#8984;&crarr;</Kbd> copy</span>
				<span class="flex items-center gap-1"><Kbd>Esc</Kbd> dismiss</span>
			</footer>
		{/if}
	{/if}
</div>
