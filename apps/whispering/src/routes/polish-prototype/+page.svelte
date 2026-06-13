<!--
  PROTOTYPE - throwaway. Spike for the Polish candidate-cards picker.
  Question: how should candidate cards present a rewrite of the selection
  (diff style, structure, keyboard model) so the flagged risks are bearable:
  long-text diff legibility, and Command-vs-manual roving selection.

  Three variations, switch via ?variant= or the floating bottom bar:
    cards   (default) manual roving selection, inline word-diff per card
    command           @epicenter/ui Command list (idiomatic shadcn), inline diff
    split             manual cards, original | candidate side-by-side with diff

  Run: bun --cwd apps/whispering run dev  ->  /polish-prototype
  Mock data only; nothing is captured, executed, or persisted.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Command from '@epicenter/ui/command';
	import { Spinner } from '@epicenter/ui/spinner';
	import { page } from '$app/state';
	import { cn } from '@epicenter/ui/utils';
	import { type DiffSegment, wordDiff } from './diff';

	type MockResult =
		| { data: string; error: null }
		| { data: null; error: { message: string } };

	type Candidate = {
		id: string;
		title: string;
		sampleIndex: number;
		result: Promise<MockResult>;
	};

	const ORIGINAL =
		'i think we should probly ship the featue tomorow, its mostly done and the bugs are minor. lets sync in the morning to go over the final detials before we push to prod.';

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function ok(output: string, ms: number): Promise<MockResult> {
		return delay(ms).then(() => ({ data: output, error: null }));
	}

	function fail(message: string, ms: number): Promise<MockResult> {
		return delay(ms).then(() => ({ data: null, error: { message } }));
	}

	// Fresh promises each run so loading states replay. Staggered delays show
	// cards filling in independently; one slow, one failed.
	function makeCandidates(): Candidate[] {
		return [
			{
				id: 'a',
				title: 'Grammar Fix',
				sampleIndex: 0,
				result: ok(
					'I think we should probably ship the feature tomorrow. It is mostly done and the bugs are minor. Let us sync in the morning to go over the final details before we push to prod.',
					500,
				),
			},
			{
				id: 'b',
				title: 'Grammar Fix',
				sampleIndex: 1,
				result: ok(
					"I think we should probably ship the feature tomorrow, since it's mostly done and the remaining bugs are minor. Let's sync in the morning to review the final details before pushing to prod.",
					1300,
				),
			},
			{
				id: 'c',
				title: 'Formal Tone',
				sampleIndex: 0,
				result: ok(
					'I believe we are positioned to ship the feature tomorrow. The work is largely complete and the outstanding defects are minor. I propose we synchronize tomorrow morning to review the remaining details prior to deploying to production.',
					2100,
				),
			},
			{
				id: 'd',
				title: 'Concise',
				sampleIndex: 0,
				result: ok(
					'Shipping the feature tomorrow; mostly done, minor bugs. Sync in the morning for a final review before prod.',
					800,
				),
			},
			{
				id: 'e',
				title: 'Translate (ES)',
				sampleIndex: 0,
				result: fail('Model request failed: 429 rate limited', 1700),
			},
		];
	}

	let candidates = $state<Candidate[]>(makeCandidates());
	let selectedIndex = $state(0);
	let outcome = $state<string | null>(null);

	const variant = $derived(page.url.searchParams.get('variant') ?? 'cards');
	const variants = ['cards', 'command', 'split'] as const;

	function rerun() {
		outcome = null;
		selectedIndex = 0;
		candidates = makeCandidates();
	}

	async function accept(candidate: Candidate) {
		const r = await candidate.result;
		outcome = r.error
			? `Tried to accept "${candidate.title}" but it failed: ${r.error.message}`
			: `Accepted "${candidate.title}" -> would writeToCursor and persist ONE run.`;
	}

	function dismiss() {
		outcome = 'Dismissed -> nothing persisted.';
	}

	// Manual roving selection for the card variants. Command owns its own nav.
	function onKeydown(event: KeyboardEvent) {
		if (variant === 'command') {
			if (event.key === 'Escape') dismiss();
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
			dismiss();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet diffInline(segments: DiffSegment[])}
	<p class="text-sm leading-relaxed whitespace-pre-wrap">
		{#each segments as seg, i (i)}
			{#if seg.type === 'equal'}<span>{seg.text}</span
				>{:else if seg.type === 'insert'}<span
					class="rounded-sm bg-green-500/15 text-green-700 dark:text-green-300"
					>{seg.text}</span
				>{:else}<span
					class="rounded-sm bg-red-500/10 text-red-700/70 line-through dark:text-red-300/60"
					>{seg.text}</span
				>{/if}
		{/each}
	</p>
{/snippet}

{#snippet sampleBadge(candidate: Candidate)}
	<div class="flex items-center gap-2">
		<span class="font-medium">{candidate.title}</span>
		<Badge variant="secondary" class="text-xs">sample {candidate.sampleIndex + 1}</Badge>
	</div>
{/snippet}

<div class="flex h-screen flex-col gap-4 p-6 pb-24">
	<header class="space-y-1">
		<h1 class="text-2xl font-semibold">Polish</h1>
		<p class="text-sm text-muted-foreground">
			Prototype - {variant} variant. Mock data, nothing persisted.
		</p>
	</header>

	<!-- Original on top, the anchor every candidate is diffed against. -->
	<Card.Root class="flex-none border-dashed">
		<Card.Header class="pb-2">
			<Card.Title class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
				Original selection
			</Card.Title>
		</Card.Header>
		<Card.Content>
			<p class="text-sm leading-relaxed whitespace-pre-wrap">{ORIGINAL}</p>
		</Card.Content>
	</Card.Root>

	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if variant === 'command'}
			<Command.Root class="rounded-lg border" value={candidates[selectedIndex]?.id}>
				<Command.Input placeholder="Filter candidates..." />
				<Command.List class="max-h-none">
					<Command.Empty>No candidates.</Command.Empty>
					{#each candidates as candidate (candidate.id)}
						<Command.Item
							value={candidate.id}
							onSelect={() => accept(candidate)}
							class="flex-col items-stretch gap-2 py-3"
						>
							{@render sampleBadge(candidate)}
							{#await candidate.result}
								<div class="flex items-center gap-2 text-sm text-muted-foreground">
									<Spinner class="size-3.5" />
									<span>Generating</span>
								</div>
							{:then r}
								{#if r.error}
									<p class="text-sm text-destructive">{r.error.message}</p>
								{:else}
									{@render diffInline(wordDiff(ORIGINAL, r.data))}
								{/if}
							{/await}
						</Command.Item>
					{/each}
				</Command.List>
			</Command.Root>
		{:else}
			<div class="flex flex-col gap-3">
				{#each candidates as candidate, index (candidate.id)}
					{@const selected = index === selectedIndex}
					<Card.Root
						role="button"
						tabindex={0}
						onclick={() => (selectedIndex = index)}
						ondblclick={() => accept(candidate)}
						class={cn(
							'cursor-pointer transition-colors',
							selected && 'border-primary ring-1 ring-primary',
						)}
					>
						<Card.Header class="flex-row items-center justify-between gap-2 pb-2">
							{@render sampleBadge(candidate)}
							{#if selected}
								<Badge class="text-xs">Enter to accept</Badge>
							{/if}
						</Card.Header>
						<Card.Content>
							{#await candidate.result}
								<div class="flex items-center gap-2 text-sm text-muted-foreground">
									<Spinner class="size-3.5" />
									<span>Generating</span>
								</div>
							{:then r}
								{#if r.error}
									<p class="text-sm text-destructive">{r.error.message}</p>
								{:else if variant === 'split'}
									<div class="grid grid-cols-2 gap-4">
										<p
											class="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground"
										>
											{ORIGINAL}
										</p>
										{@render diffInline(wordDiff(ORIGINAL, r.data))}
									</div>
								{:else}
									{@render diffInline(wordDiff(ORIGINAL, r.data))}
								{/if}
							{/await}
						</Card.Content>
					</Card.Root>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- Floating control bar: switch variants, re-run the fan-out, see the outcome. -->
<div
	class="fixed inset-x-0 bottom-0 flex items-center gap-3 border-t bg-background/95 p-3 backdrop-blur"
>
	<span class="text-xs font-medium text-muted-foreground">variant:</span>
	{#each variants as v (v)}
		<Button
			href={`?variant=${v}`}
			variant={variant === v ? 'default' : 'outline'}
			size="sm"
		>
			{v}
		</Button>
	{/each}
	<Button variant="ghost" size="sm" onclick={rerun}>Re-run</Button>
	<div class="ml-auto text-sm">
		{#if outcome}
			<span class="text-muted-foreground">{outcome}</span>
		{:else}
			<span class="text-muted-foreground">
				&uarr;&darr; navigate &middot; Enter accept &middot; Esc dismiss
			</span>
		{/if}
	</div>
</div>
