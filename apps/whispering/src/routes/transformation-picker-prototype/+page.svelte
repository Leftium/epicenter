<!--
  PROTOTYPE - throwaway. Web-viewable preview of the transformation picker with
  mock data (the real /transformation-picker window needs Tauri events for its
  input, so it can't render standalone in a browser). Mirrors the shipped flow:
  chips toggle transformations live, candidate cards diff against the selection.
  Run: bun --cwd apps/whispering run dev:web  ->  /transformation-picker-prototype
  Mock data only; nothing is captured, executed, or persisted.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Kbd } from '@epicenter/ui/kbd';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import { Err, Ok, type Result } from 'wellcrafted/result';
	import CandidateCards from '$lib/components/CandidateCards.svelte';

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

	type Candidate = {
		id: string;
		transformation: { title: string };
		result: Promise<Result<string, { message: string }>>;
	};

	function mockResult(id: string): Promise<Result<string, { message: string }>> {
		const ms = 400 + (id.length % 4) * 500;
		return new Promise((resolve) =>
			setTimeout(
				() =>
					resolve(
						id === 'bullets'
							? Err({ message: 'Model request failed: 429 rate limited' })
							: Ok(MOCK_OUTPUT[id] ?? ''),
					),
				ms,
			),
		);
	}

	let activeIds = $state<string[]>(['grammar']);
	let candidates = $state<Candidate[]>([]);
	let selectedIndex = $state(0);

	function reconcile(ids: string[]) {
		const existing = new Map(candidates.map((c) => [c.id, c]));
		candidates = ids.map(
			(id) =>
				existing.get(id) ?? {
					id,
					transformation: {
						title: TRANSFORMATIONS.find((t) => t.id === id)?.title ?? id,
					},
					result: mockResult(id),
				},
		);
		selectedIndex = Math.min(selectedIndex, Math.max(0, candidates.length - 1));
	}

	// Seed the initial selection's candidate.
	$effect(() => {
		if (candidates.length === 0 && activeIds.length > 0) reconcile(activeIds);
	});

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

<div class="flex h-screen flex-col gap-4 p-6">
	<header class="flex-none space-y-1">
		<h2 class="text-2xl font-semibold tracking-tight">Transformations</h2>
		<p class="text-sm text-muted-foreground">
			Prototype - mock data. Toggle transformations to run on your selection.
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

	<ToggleGroup.Root
		type="multiple"
		bind:value={activeIds}
		onValueChange={reconcile}
		class="flex flex-none flex-wrap justify-start gap-2"
	>
		{#each TRANSFORMATIONS as t (t.id)}
			<ToggleGroup.Item
				value={t.id}
				class="rounded-md border-0 bg-muted px-3 text-muted-foreground hover:bg-muted/70 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
			>
				{t.title}
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
			original={ORIGINAL}
			bind:selectedIndex
			onaccept={() => alert(`Accept "${candidates[selectedIndex]?.transformation.title}"`)}
		/>
		<footer
			class="flex flex-none items-center gap-4 border-t pt-3 text-xs text-muted-foreground"
		>
			<span class="flex items-center gap-1">
				<Kbd>&uarr;</Kbd><Kbd>&darr;</Kbd>
				navigate
			</span>
			<span class="flex items-center gap-1"><Kbd>Enter</Kbd> accept</span>
			<Button variant="ghost" size="sm" class="ml-auto" onclick={() => reconcile(activeIds)}>
				Re-run
			</Button>
		</footer>
	{/if}
</div>
