<!--
  PROTOTYPE - throwaway. Spike for MULTI-transformation selection in the picker.
  Question: when you want several transformations run on one selection (k > 1),
  how do you choose them? Two styles, switch via ?style= or the floating bar:

    chips      ToggleGroup of transformations; toggling one runs it live, so
               candidate cards appear/disappear as you select. No Run button.
    checklist  Checkbox list; pick several, then hit "Run N" once. Explicit,
               batches the calls, nothing fires until you commit.

  The candidate cards reuse the shipped design (roving selection, inline diff).
  Run: bun --cwd apps/whispering run dev:web  ->  /transformation-picker-prototype
  Mock data only; nothing is captured, executed, or persisted.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Kbd } from '@epicenter/ui/kbd';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { cn } from '@epicenter/ui/utils';
	import { type DiffSegment, wordDiff } from '$lib/utils/word-diff';

	const ORIGINAL =
		'i think we should probly ship the featue tomorow, its mostly done and the bugs are minor. lets sync in the morning to go over the final detials before we push to prod.';

	const TRANSFORMATIONS = [
		{ id: 'grammar', title: 'Grammar Fix' },
		{ id: 'formal', title: 'Formal Tone' },
		{ id: 'concise', title: 'Concise' },
		{ id: 'friendly', title: 'Friendly' },
		{ id: 'bullets', title: 'Bullet Points' },
	];

	const MOCK_OUTPUT: Record<string, string> = {
		grammar:
			'I think we should probably ship the feature tomorrow. It is mostly done and the bugs are minor. Let us sync in the morning to go over the final details before we push to prod.',
		formal:
			'I believe we are positioned to ship the feature tomorrow. The work is largely complete and the outstanding defects are minor. I propose we synchronize tomorrow morning to review the remaining details prior to deploying to production.',
		concise:
			'Shipping the feature tomorrow; mostly done, minor bugs. Sync in the morning for a final review before prod.',
		friendly:
			"I think we're good to ship the feature tomorrow! It's mostly done and the bugs are pretty minor. Let's sync in the morning to look over the final details before we push to prod.",
		bullets:
			'- Ship the feature tomorrow (mostly done)\n- Remaining bugs are minor\n- Morning sync to review final details before prod',
	};

	type MockResult =
		| { data: string; error: null }
		| { data: null; error: { message: string } };

	type Candidate = {
		id: string;
		title: string;
		result: Promise<MockResult>;
	};

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// Vary the delay by id so cards fill in independently, like real completions.
	function mockResult(id: string): Promise<MockResult> {
		const ms = 400 + (id.length % 4) * 500;
		return delay(ms).then(() => ({ data: MOCK_OUTPUT[id] ?? '', error: null }));
	}

	const style = $derived(page.url.searchParams.get('style') ?? 'chips');

	const selected = new SvelteSet<string>(['grammar']);
	let toggleValue = $state<string[]>(['grammar']);
	let candidates = $state<Candidate[]>([]);
	let selectedIndex = $state(0);
	let cardRefs = $state<(HTMLElement | null)[]>([]);

	function runFor(ids: string[]) {
		candidates = ids.map((id) => ({
			id,
			title: TRANSFORMATIONS.find((t) => t.id === id)?.title ?? id,
			result: mockResult(id),
		}));
		selectedIndex = 0;
	}

	// Chips style is live: every toggle re-runs the selected set.
	$effect(() => {
		if (style === 'chips') runFor(toggleValue);
	});

	$effect(() => {
		cardRefs[selectedIndex]?.scrollIntoView({ block: 'nearest' });
	});

	function toggleChecklist(id: string, checked: boolean) {
		if (checked) selected.add(id);
		else selected.delete(id);
	}

	function onKeydown(event: KeyboardEvent) {
		if (!candidates.length) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, candidates.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
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

<div class="flex h-screen flex-col gap-4 p-6 pb-20">
	<header class="flex-none space-y-1">
		<h2 class="text-2xl font-semibold tracking-tight">Transformations</h2>
		<p class="text-sm text-muted-foreground">
			Prototype - {style} selection. Run several transformations on one selection.
		</p>
	</header>

	<Card.Root class="flex-none gap-0 border-dashed bg-muted/30 py-3">
		<Card.Header class="gap-0 px-4 pb-1">
			<Card.Title
				class="text-[0.7rem] font-medium tracking-wider text-muted-foreground uppercase"
			>
				Your selection
			</Card.Title>
		</Card.Header>
		<Card.Content class="px-4">
			<p class="text-sm leading-relaxed whitespace-pre-wrap">{ORIGINAL}</p>
		</Card.Content>
	</Card.Root>

	<!-- Selection step: the part this prototype is actually asking about. -->
	{#if style === 'chips'}
		<ToggleGroup.Root
			type="multiple"
			bind:value={toggleValue}
			variant="outline"
			class="flex-none flex-wrap justify-start gap-2"
		>
			{#each TRANSFORMATIONS as t (t.id)}
				<ToggleGroup.Item value={t.id} class="data-[state=on]:bg-primary/10">
					{t.title}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	{:else}
		<div class="flex flex-none flex-col gap-2 rounded-lg border p-3">
			{#each TRANSFORMATIONS as t (t.id)}
				<label class="flex cursor-pointer items-center gap-2 text-sm">
					<Checkbox
						checked={selected.has(t.id)}
						onCheckedChange={(checked) => toggleChecklist(t.id, checked === true)}
					/>
					{t.title}
				</label>
			{/each}
			<Button
				size="sm"
				class="mt-1 self-start"
				disabled={selected.size === 0}
				onclick={() => runFor([...selected])}
			>
				Run {selected.size || ''}
			</Button>
		</div>
	{/if}

	<div class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
		{#each candidates as candidate, index (candidate.id)}
			{@const isSelected = index === selectedIndex}
			<Card.Root
				bind:ref={cardRefs[index]}
				role="button"
				tabindex={0}
				aria-selected={isSelected}
				onclick={() => (selectedIndex = index)}
				class={cn(
					'cursor-pointer gap-2 py-3 transition-colors outline-none',
					isSelected
						? 'border-primary bg-primary/5 ring-1 ring-primary'
						: 'hover:border-muted-foreground/30',
				)}
			>
				<Card.Header class="flex-row items-center justify-between gap-2 px-4">
					<span class="text-sm font-medium">{candidate.title}</span>
					{#if isSelected}
						<span class="flex items-center gap-1 text-xs text-muted-foreground">
							<Kbd>Enter</Kbd> to accept
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
							{@render diffInline(wordDiff(ORIGINAL, result.data))}
						{/if}
					{/await}
				</Card.Content>
			</Card.Root>
		{/each}
	</div>
</div>

<div
	class="fixed inset-x-0 bottom-0 flex items-center gap-3 border-t bg-background/95 p-3 backdrop-blur"
>
	<span class="text-xs font-medium text-muted-foreground">selection style:</span>
	<Button href="?style=chips" variant={style === 'chips' ? 'default' : 'outline'} size="sm">
		chips (live)
	</Button>
	<Button
		href="?style=checklist"
		variant={style === 'checklist' ? 'default' : 'outline'}
		size="sm"
	>
		checklist (run)
	</Button>
	<span class="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
		<Kbd>&uarr;</Kbd><Kbd>&darr;</Kbd> navigate candidates
	</span>
</div>
