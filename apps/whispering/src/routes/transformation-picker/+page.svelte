<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Card from '@epicenter/ui/card';
	import { Kbd } from '@epicenter/ui/kbd';
	import { Spinner } from '@epicenter/ui/spinner';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { cn } from '@epicenter/ui/utils';
	import TransformationPickerBody from '$lib/components/TransformationPickerBody.svelte';
	import { type Candidate, fanOutCandidates } from '$lib/operations/candidates';
	import { persistCompletedRun } from '$lib/operations/transform';
	import { sound } from '$lib/operations/sound';
	import { report } from '$lib/report';
	import { services } from '$lib/services';
	import type { Transformation } from '$lib/workspace';
	import { type DiffSegment, wordDiff } from '$lib/utils/word-diff';
	import * as pickerWindow from './transformationPickerWindow.tauri';

	/**
	 * Candidates generated for a prompt-based transformation. Each is an
	 * independent completion, so they vary; deterministic (replacements-only)
	 * transformations collapse to a single candidate since repeating them yields
	 * identical text. The sample count is an invocation parameter, never stored on
	 * the transformation.
	 */
	const SAMPLE_COUNT = 3;

	// The captured selection, handed over by the main window after the shortcut
	// simulates a copy. Empty until the first input event arrives.
	let input = $state('');
	let stage = $state<'picker' | 'candidates'>('picker');
	let candidates = $state<Candidate[]>([]);
	let selectedIndex = $state(0);
	// When the fan-out kicked off; persisted as the accepted run's startedAt.
	let startedAt = $state('');
	// DOM nodes per candidate card, so arrow-key selection can scroll into view.
	let cardRefs = $state<(HTMLElement | null)[]>([]);

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

	// Keep the highlighted card visible as the user arrows through a long list.
	$effect(() => {
		cardRefs[selectedIndex]?.scrollIntoView({ block: 'nearest' });
	});

	// Each open starts fresh at the picker over the newly captured selection.
	function receiveInput(text: string) {
		input = text;
		stage = 'picker';
		candidates = [];
		selectedIndex = 0;
	}

	function runFanOut(transformation: Transformation) {
		const samples = transformation.prompt ? SAMPLE_COUNT : 1;
		startedAt = new Date().toISOString();
		candidates = fanOutCandidates({
			input,
			transformations: [transformation],
			samples,
		});
		selectedIndex = 0;
		stage = 'candidates';
	}

	async function accept(candidate: Candidate) {
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
			startedAt,
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

	// The candidate stage is keyboard-driven; the picker stage owns its own keys.
	function onKeydown(event: KeyboardEvent) {
		if (stage !== 'candidates') {
			if (event.key === 'Escape') void dismiss();
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, candidates.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const candidate = candidates[selectedIndex];
			if (candidate) void accept(candidate);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			void dismiss();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet diffInline(segments: DiffSegment[])}
	<p class="text-sm leading-relaxed whitespace-pre-wrap">
		{#each segments as seg, i (i)}
			{#if seg.type === 'equal'}<span>{seg.text}</span
				>{:else if seg.type === 'insert'}<span
					class="rounded-sm bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
					>{seg.text}</span
				>{:else}<span
					class="rounded-sm bg-red-500/10 text-red-700/70 line-through dark:text-red-300/60"
					>{seg.text}</span
				>{/if}
		{/each}
	</p>
{/snippet}

<div class="flex h-screen flex-col gap-4 p-6">
	<header class="flex-none space-y-1">
		<h2 class="text-2xl font-semibold tracking-tight">Transformations</h2>
		<p class="text-sm text-muted-foreground">
			{stage === 'picker'
				? 'Pick a transformation to run on your selected text'
				: 'Choose a result, then accept it to replace your selection'}
		</p>
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

	{#if stage === 'picker'}
		<TransformationPickerBody
			onSelect={runFanOut}
			onSelectManageTransformations={async () => {
				await dismiss();
				await emit('navigate-main-window', { path: '/transformations' });
			}}
			placeholder="Search transformations..."
		/>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
			{#each candidates as candidate, index (candidate.id)}
				{@const selected = index === selectedIndex}
				<Card.Root
					bind:ref={cardRefs[index]}
					role="button"
					tabindex={0}
					aria-selected={selected}
					onclick={() => (selectedIndex = index)}
					ondblclick={() => accept(candidate)}
					class={cn(
						'cursor-pointer gap-2 py-3 transition-colors outline-none',
						selected
							? 'border-primary bg-primary/5 ring-1 ring-primary'
							: 'hover:border-muted-foreground/30',
					)}
				>
					<Card.Header class="flex-row items-center justify-between gap-2 px-4">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium">
								{candidate.transformation.title || 'Untitled transformation'}
							</span>
							{#if candidates.length > 1}
								<Badge variant="secondary" class="px-1.5 text-xs tabular-nums">
									{candidate.sampleIndex + 1}
								</Badge>
							{/if}
						</div>
						{#if selected}
							<span class="flex items-center gap-1 text-xs text-muted-foreground">
								<Kbd>Enter</Kbd>
								to accept
							</span>
						{/if}
					</Card.Header>
					<Card.Content class="px-4">
						{#await candidate.result}
							<div class="flex items-center gap-2 text-sm text-muted-foreground">
								<Spinner class="size-3.5" />
								<span>Generating</span>
							</div>
						{:then result}
							{#if result.error}
								<p class="text-sm text-destructive">{result.error.message}</p>
							{:else}
								{@render diffInline(wordDiff(input, result.data))}
							{/if}
						{/await}
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

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
</div>
