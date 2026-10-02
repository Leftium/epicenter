<script lang="ts">
	import { type Thought, toTextarea } from '@epicenter/capture';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Field from '@epicenter/ui/field';
	import { toast } from '@epicenter/ui/sonner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import { onMount, tick } from 'svelte';
	import type { Captures } from '$lib/captures.svelte.js';
	import { copyText, downloadText } from '$lib/download.js';
	import type { CaptureEntry, Draft } from '$lib/draft.svelte.js';
	import DraftRecovery from './DraftRecovery.svelte';

	let {
		draft,
		captures,
		stem,
		focusNewThought = false,
		onBack,
		onOpen,
	}: {
		draft: Draft;
		captures: Captures;
		stem: string;
		/** The capture was just added: the next thing to type is a thought. */
		focusNewThought?: boolean;
		onBack: () => void;
		onOpen: (stem: string) => void;
	} = $props();

	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	let view = $state('capture');
	const document = $derived(draft.document);
	/**
	 * How the draft reads as a row. The time and the messages below describe
	 * the text on screen, saved or not, and never the file as it was last saved.
	 */
	const reading = $derived(draft.reading);
	const capturedAt = $derived.by(() => {
		const value = reading.fields.capturedAt;
		if (value === undefined) return undefined;
		const time = new Date(value);
		return Number.isNaN(time.getTime()) ? undefined : time;
	});
	/** Fields that need fixing in a draft that parses. A draft that does not is Source only, below. */
	const issues = $derived(reading.issues.map((issue) => issue.message));
	// A thought edit whose thought is no longer in the document as shown.
	const strandedEdit = $derived(
		draft.editing !== undefined && !document.thoughts.includes(draft.editing.thought)
			? draft.editing
			: undefined,
	);

	let sourceField = $state<HTMLTextAreaElement | null>(null);
	let newThoughtField = $state<HTMLTextAreaElement | null>(null);
	let thoughtList = $state<HTMLOListElement>();

	onMount(() => {
		if (focusNewThought) newThoughtField?.focus();
	});

	// Engines without content-sized fields fall back to this many rows.
	const rowsFor = (text: string) => Math.min(12, Math.max(3, text.split('\n').length + 1));

	function submitOnModEnter(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
		if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	function focusAtEnd(node: HTMLTextAreaElement) {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}

	/**
	 * Put focus on a thought's menu once the control that had it is gone, or on
	 * the nearest thought, or on Add a thought when there are none.
	 */
	async function focusThought(index: number) {
		await tick();
		const menus = thoughtList?.querySelectorAll<HTMLElement>('[data-thought-actions]');
		const menu = menus?.[Math.min(index, menus.length - 1)];
		(menu ?? newThoughtField)?.focus();
	}

	/** Where focus goes when the open menu closes, when its action moved things. */
	let afterMenu: (() => void) | undefined;
	function onMenuClosed(event: Event) {
		if (!afterMenu) return;
		event.preventDefault();
		afterMenu();
		afterMenu = undefined;
	}

	async function showSource() {
		view = 'source';
		await tick();
		sourceField?.focus();
	}

	function addThought(event: SubmitEvent) {
		event.preventDefault();
		draft.addThought();
		newThoughtField?.focus();
	}

	function saveEdit(index: number) {
		if (draft.commitEditing()) void focusThought(index);
	}

	function cancelEdit(index: number) {
		draft.cancelEditing();
		void focusThought(index);
	}

	function startEdit(thought: Thought) {
		draft.startEditing(thought);
		// The editor takes focus as it appears; the menu must not take it back.
		afterMenu = () => {};
	}

	function move(thought: Thought, to: number) {
		const neighbour = document.thoughts[to];
		if (neighbour && draft.swapThoughts(thought, neighbour)) afterMenu = () => void focusThought(to);
	}

	async function copy(text: string, what: string) {
		if (await copyText(text)) toast.success(`${what} copied`);
		else toast.error(`Could not copy. Select the text and copy it.`);
	}

	function confirmDeleteThought(thought: Thought, index: number) {
		confirmationDialog.open({
			title: 'Delete this thought?',
			description: thought.text.length > 300 ? `${thought.text.slice(0, 300)}…` : thought.text,
			confirm: { text: 'Delete thought', variant: 'destructive' },
			onConfirm: () => {
				if (draft.deleteThought(thought)) void focusThought(index);
			},
		});
	}

	// Deleting reviews the saved file as it is now, and deletes exactly that.
	let deletion = $state.raw<CaptureEntry | undefined>();
	let deletionProblem = $state('');
	let deleting = $state(false);
	async function reviewDeletion() {
		const reviewed = await captures.reviewDeletion(stem);
		if (!reviewed.ok) {
			deletionProblem = reviewed.message;
			deletion = undefined;
			return;
		}
		deletionProblem = '';
		deletion = reviewed.entry;
	}
	function cancelDeletion() {
		if (deleting) return;
		deletion = undefined;
		deletionProblem = '';
	}
	async function confirmDeletion() {
		if (!deletion || deleting) return;
		deleting = true;
		try {
			const removed = await captures.remove(deletion);
			if (removed.ok) {
				deletion = undefined;
				onBack();
				return;
			}
			deletionProblem = removed.changed
				? 'This capture changed since you reviewed it. Review it again before deleting.'
				: removed.message;
			if (removed.changed) await reviewDeletion();
		} finally {
			deleting = false;
		}
	}
</script>

<Tabs.Root bind:value={view} class="gap-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<h1 class="mr-auto basis-full text-lg font-semibold tracking-tight sm:basis-auto">
			{#if capturedAt}
				<time datetime={capturedAt.toISOString()}>{when.format(capturedAt)}</time>
			{:else}
				Capture with no date
			{/if}
		</h1>
		<Tabs.List aria-label="View">
			<Tabs.Trigger value="capture">Capture</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" aria-label="More capture actions">More</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				<DropdownMenu.Item onclick={() => copy(draft.buffer, 'Source')}>Copy source</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => downloadText(`${stem}.md`, draft.buffer)}>Download file</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onclick={reviewDeletion}>Delete capture…</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	{#if issues.length}
		<Alert.Root variant="destructive">
			<Alert.Title>This file needs repair</Alert.Title>
			<Alert.Description>
				<ul class="list-disc pl-5">{#each issues as issue (issue)}<li>{issue}</li>{/each}</ul>
				Fix it in Source. The capture text and thoughts still work.
			</Alert.Description>
		</Alert.Root>
	{/if}

	{#if deletionProblem && !deletion}
		<Alert.Root variant="destructive">
			<Alert.Title>This capture was not deleted</Alert.Title>
			<Alert.Description>{deletionProblem}</Alert.Description>
		</Alert.Root>
	{/if}

	<DraftRecovery {draft} {captures} {onBack} {onOpen} />

	{#if draft.refusal}
		<Alert.Root aria-label="Not applied">
			<Alert.Title>Not applied</Alert.Title>
			<Alert.Description>{draft.refusal}</Alert.Description>
		</Alert.Root>
	{/if}

	<Tabs.Content value="capture" class="flex flex-col gap-8">
		{#if document.refusal}
			<Alert.Root aria-label="Source only">
				<Alert.Title>This capture can only be edited as Source</Alert.Title>
				<Alert.Description>
					<p>{document.refusal.message}</p>
					{#if reading.parseError}
						<ul class="list-disc pl-5">
							{#each reading.parseError.diagnostics as diagnostic, index (index)}
								{#if diagnostic.message !== reading.parseError.message}<li>{diagnostic.message}</li>{/if}
							{/each}
						</ul>
					{/if}
					Nothing was changed. The whole file is in Source, where you can edit it directly.
				</Alert.Description>
				<div class="mt-2"><Button variant="outline" size="sm" onclick={showSource}>Edit Source</Button></div>
			</Alert.Root>
		{:else}
			<Field.Field>
				<Field.Label for="capture-text">Capture text</Field.Label>
				<Textarea
					id="capture-text"
					value={draft.text}
					oninput={(event) => draft.inputText(event.currentTarget.value)}
					rows={rowsFor(draft.text)}
					class="max-h-96 resize-y leading-relaxed"
					placeholder="Write here…"
				/>
				{#if draft.textIsPending}
					<div role="status" class="flex flex-wrap items-center gap-3">
						This text is kept here but not in the file yet.
						<Button variant="outline" size="sm" onclick={() => draft.dropPendingText()}>Go back to the saved text</Button>
					</div>
				{/if}
			</Field.Field>

			<section class="flex flex-col gap-3" aria-label="Capture thoughts">
				<h2 class="font-medium">
					Thoughts
					{#if document.thoughts.length}<span class="font-normal text-muted-foreground">{document.thoughts.length}</span>{/if}
				</h2>

				{#if strandedEdit}
					<Alert.Root aria-label="Kept thought edit">
						<Alert.Title>Your edit to a thought was not applied</Alert.Title>
						<Alert.Description>The capture changed after you started editing, so it is unclear which thought this belongs to. Your text is kept here. Copy it, then edit the thought again.</Alert.Description>
						<Textarea aria-label="Kept thought text" value={strandedEdit.text} oninput={(event) => draft.inputEditing(event.currentTarget.value)} rows={3} class="mt-2" />
						<div class="mt-2 flex flex-wrap gap-2">
							<Button variant="outline" size="sm" onclick={() => copy(strandedEdit.text, 'Text')}>Copy text</Button>
							<Button variant="outline" size="sm" onclick={() => draft.cancelEditing()}>Discard this edit</Button>
						</div>
					</Alert.Root>
				{/if}

				{#if document.thoughts.length}
					<ol bind:this={thoughtList} aria-label="Thoughts" class="list-decimal divide-y border-y pl-6 marker:text-muted-foreground">
						{#each document.thoughts as thought, index (index)}
							<li class="py-1 pl-1">
								{#if draft.editing?.thought === thought}
									<form class="flex flex-col gap-2 py-1" onsubmit={(event) => { event.preventDefault(); saveEdit(index); }}>
										<Textarea
											aria-label="Thought text"
											value={draft.editing.text}
											oninput={(event) => draft.inputEditing(event.currentTarget.value)}
											onkeydown={submitOnModEnter}
											rows={rowsFor(draft.editing.text)}
											class="leading-relaxed"
											{@attach focusAtEnd}
										/>
										<div class="flex flex-wrap gap-2">
											<Button type="submit" size="sm">Save thought</Button>
											<Button size="sm" variant="outline" onclick={() => cancelEdit(index)}>Cancel</Button>
										</div>
									</form>
								{:else}
									<div class="flex items-start gap-2">
										<p class="min-w-0 flex-1 whitespace-pre-wrap break-words py-1.5 leading-relaxed {thought.text ? '' : 'text-muted-foreground'}">{thought.text || 'Empty thought'}</p>
										<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Button {...props} variant="ghost" size="sm" class="text-muted-foreground" aria-label="Thought actions" data-thought-actions>Actions</Button>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content align="end" class="w-48" onCloseAutoFocus={onMenuClosed}>
												<DropdownMenu.Item disabled={draft.editing !== undefined} onclick={() => startEdit(thought)}>Edit</DropdownMenu.Item>
												<DropdownMenu.Item disabled={index === 0} onclick={() => move(thought, index - 1)}>Move up</DropdownMenu.Item>
												<DropdownMenu.Item disabled={index === document.thoughts.length - 1} onclick={() => move(thought, index + 1)}>Move down</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item onclick={() => copy(thought.text, 'Thought')}>Copy text</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item variant="destructive" onclick={() => confirmDeleteThought(thought, index)}>Delete thought…</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</div>
								{/if}
							</li>
						{/each}
					</ol>
				{/if}

				<form onsubmit={addThought} class="flex flex-col gap-2">
					<Field.Field>
						<Field.Label for="new-thought">Add a thought</Field.Label>
						<Textarea
							id="new-thought"
							bind:ref={newThoughtField}
							bind:value={draft.newThought}
							onkeydown={submitOnModEnter}
							rows={2}
							class="leading-relaxed"
							placeholder="Write a line or paragraph…"
						/>
					</Field.Field>
					<div class="flex items-center justify-between gap-3">
						<p class="text-xs text-muted-foreground">
							{#if draft.newThought !== ''}
								Not added yet. It stays here until you add it or clear it.
							{:else if document.thoughts.length}
								Ctrl or ⌘ + Enter adds it after the last thought.
							{:else if document.hasSection}
								Thoughts you add are saved in this capture, under its Thoughts heading.
							{:else}
								This file has no Thoughts section yet. Adding a thought appends one.
							{/if}
						</p>
						<Button type="submit" size="sm">Add thought</Button>
					</div>
				</form>

				{#if document.hasOtherContent}
					<p class="text-muted-foreground">This file has more Markdown after its thoughts. It is kept as it is, and shown in Source.</p>
				{/if}
			</section>
		{/if}
	</Tabs.Content>

	<Tabs.Content value="source">
		<Field.Field>
			<Field.Label for="capture-source">Markdown source</Field.Label>
			<Field.Description>This is the file <code class="break-all">{draft.path}</code>, exactly. Anything Markdown allows can go here.</Field.Description>
			<Textarea
				id="capture-source"
				bind:ref={sourceField}
				value={toTextarea(draft.buffer)}
				oninput={(event) => draft.inputSource(event.currentTarget.value)}
				rows={18}
				spellcheck={false}
				class="min-h-64 resize-y font-mono"
			/>
		</Field.Field>
	</Tabs.Content>
</Tabs.Root>

<Dialog.Root bind:open={() => deletion !== undefined, (open) => { if (!open) cancelDeletion(); }}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Permanently delete this capture file?</Dialog.Title>
			<Dialog.Description>This is the saved file as it is now. Its thoughts are part of it and go with it. Recorded earlier versions remain in Git history.</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-w-0 flex-col gap-3">
			{#if draft.unsettled}<p class="font-medium">Text in this window that is not saved will be discarded too.</p>{/if}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the preview scrolls, so the keyboard must reach it -->
			<pre aria-label="Saved file" role="region" tabindex="0" class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs">{deletion?.source}</pre>
			{#if deletionProblem}<p role="status">{deletionProblem}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" disabled={deleting} onclick={cancelDeletion}>Cancel</Button>
			<Button variant="destructive" disabled={deleting} onclick={confirmDeletion}>{deleting ? 'Deleting…' : 'Permanently delete'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
