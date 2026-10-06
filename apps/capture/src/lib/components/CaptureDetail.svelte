<script lang="ts">
	import { toTextarea } from '@epicenter/capture';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Field from '@epicenter/ui/field';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { onDestroy, onMount, tick } from 'svelte';
	import type { Captures } from '$lib/captures.svelte.js';
	import { copyText, downloadText } from '$lib/download.js';
	import type { Draft, DraftView } from '$lib/draft.svelte.js';
	import { Textarea } from '@epicenter/ui/textarea';
	import DraftRecovery from './DraftRecovery.svelte';
	import TechnicalDetails from './TechnicalDetails.svelte';
	import ThoughtEditForm from './ThoughtEditForm.svelte';

	let {
		draft,
		captures,
		stem,
		focusNewThought = false,
		onBack,
		onDeleted,
		onOpen,
	}: {
		draft: Draft;
		captures: Captures;
		stem: string;
		/** The capture was just added: the next thing to type is a thought. */
		focusNewThought?: boolean;
		onBack: () => void;
		/** Completion belongs to the app container even after deletion removes this view. */
		onDeleted: (stem: string) => void;
		onOpen: (stem: string) => void;
	} = $props();

	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	/**
	 * Cleared on destroy, for this view's commands. Each text box also has its
	 * own lifetime (`Textarea`): a block inside this view can go and come back
	 * while the view stays, and its old text box must not write again.
	 */
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});

	/** Why the Capture view has no fields, when the file has none. */
	const sourceOnly = $derived.by((): string | undefined => {
		if (draft.status === 'invalid')
			return `This file cannot be edited as a capture until it is repaired: ${draft.rowProblem}`;
		return draft.document.refusal?.message;
	});
	$effect(() => {
		if (draft.loaded && sourceOnly !== undefined) draft.setView('source');
	});

	const capturedAt = $derived.by(() => {
		const value = draft.reading.fields.capturedAt;
		if (value === undefined) return undefined;
		const time = new Date(value);
		return Number.isNaN(time.getTime()) ? undefined : time;
	});
	/** Fields that need fixing in text that parses. Text that does not is Source only, below. */
	const issues = $derived(draft.loaded ? draft.reading.issues.map((issue) => issue.message) : []);
	// A thought edit whose thought is no longer in the document as shown.
	const strandedEdit = $derived(
		draft.editing !== undefined && draft.document.thoughts !== draft.editing.thoughts
			? draft.editing
			: undefined,
	);
	/** Nothing a person does is taken: leaving, deleting, or another operation holds it. */
	const held = $derived(!draft.admitted);

	// Every binding reads the draft this view has now, at the call, and each
	// writer returns unless its own view is the one shown and can be edited.
	const fieldsLive = () => mounted && draft.view === 'capture' && draft.structured;
	const sourceLive = () => mounted && draft.view === 'source' && draft.loaded;

	function setView(next: string) {
		if (!mounted || held) return;
		draft.setView(next as DraftView);
	}

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
		setView('source');
		await tick();
		sourceField?.focus();
	}

	function move(from: number, to: number, shown: readonly string[]) {
		if (!fieldsLive()) return;
		if (draft.swapThoughts(from, to, shown)) afterMenu = () => void focusThought(to);
	}

	async function copy(text: string, what: string) {
		if (await copyText(text)) toast.success(`${what} copied`);
		else toast.error(`Could not copy. Select the text and copy it.`);
	}

	function confirmDeleteThought(thought: string, index: number, shown: readonly string[]) {
		if (!fieldsLive() || draft.document.thoughts !== shown) return;
		confirmationDialog.open({
			title: 'Delete this thought?',
			description: thought.length > 300 ? `${thought.slice(0, 300)}…` : thought,
			confirm: { text: 'Delete thought', variant: 'destructive' },
			onConfirm: () => {
				if (fieldsLive() && draft.deleteThought(index, shown)) void focusThought(index);
			},
		});
	}

	// Deleting settles this capture, reads the saved file as it is now, and
	// deletes exactly what the person saw, without reading it again. The
	// review is the draft's, so it outlives this view; a delete once sent
	// runs to its answer wherever the views are.
	/** A delete can be sent now: not leaving, not closing, not let go, not already sending. */
	const mayDelete = $derived(!captures.fenced && !draft.retired && !draft.removing);
	function cancelDeletion() {
		if (!mounted) return;
		draft.cancelDeletion();
	}
	async function confirmDeletion() {
		if (!mounted || !mayDelete) return;
		const deletedStem = stem;
		const completed = onDeleted;
		if (await captures.remove(draft)) completed(deletedStem);
	}
</script>

{#if !draft.loaded}
	{#if draft.refused}
		<Alert.Root variant="destructive" aria-label="File unavailable">
			<Alert.Title>{draft.refused.missing ? 'This file is not in the folder' : 'This file cannot be read'}</Alert.Title>
			<Alert.Description>It was not changed by this window. Check again once it is back or repaired.</Alert.Description>
			<div class="mt-2 text-foreground"><Button variant="outline" size="sm" onclick={() => captures.refresh()}>Check again</Button></div>
			<TechnicalDetails detail={draft.refused.message} />
		</Alert.Root>
	{:else}
		<Loading label="Opening…" />
	{/if}
{:else}
	<Tabs.Root bind:value={() => draft.view, setView} class="gap-4">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<h1 class="mr-auto basis-full text-lg font-semibold tracking-tight sm:basis-auto">
				{#if capturedAt}
					<time datetime={capturedAt.toISOString()}>{when.format(capturedAt)}</time>
				{:else}
					Capture with no date
				{/if}
			</h1>
			<Tabs.List aria-label="View">
				<Tabs.Trigger value="capture" disabled={held || !draft.structured || draft.document.refusal !== undefined}>Capture</Tabs.Trigger>
				<Tabs.Trigger value="source" disabled={held}>Source</Tabs.Trigger>
			</Tabs.List>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="sm" aria-label="More capture actions">More</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-48">
					<DropdownMenu.Item onclick={() => copy(draft.source, 'Source')}>Copy source</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => downloadText(`${stem}.md`, draft.source)}>Download file</DropdownMenu.Item>
					<!-- Shows the file as it is now, in place of what this window shows. A choice waiting for the person has its own. -->
					<DropdownMenu.Item disabled={held || draft.notice !== undefined} onclick={() => {
						if (!mounted || held) return;
						void draft.reload();
					}}>Reload from file</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" disabled={held} onclick={() => {
						if (!mounted || held) return;
						void captures.reviewDeletion(draft);
					}}>Delete capture…</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>

		{#if issues.length}
			<Alert.Root variant="destructive">
				<Alert.Title>This file needs repair</Alert.Title>
				<Alert.Description>
					<ul class="list-disc pl-5">{#each issues as issue (issue)}<li>{issue}</li>{/each}</ul>
					Fix it in Source.
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if draft.deletionProblem && !draft.deletionReview}
			<Alert.Root variant="destructive">
				<Alert.Title>This capture was not deleted</Alert.Title>
				<Alert.Description>{draft.deletionProblem}</Alert.Description>
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
			{#if sourceOnly === undefined}
				<Field.Field>
					<Field.Label for="capture-text">Capture text</Field.Label>
					<Textarea
						id="capture-text"
						readonly={held}
						bind:value={
							() => draft.text,
							(value) => {
								if (fieldsLive()) draft.inputText(value);
							}
						}
						rows={rowsFor(draft.text)}
						class="max-h-96 resize-y leading-relaxed"
						placeholder="Write here…"
					/>
					{#if draft.textIsPending}
						<div role="status" class="flex flex-wrap items-center gap-3">
							This text is kept here but not in the file yet.
							<Button variant="outline" size="sm" disabled={held} onclick={() => draft.dropPendingText()}>Go back to the saved text</Button>
						</div>
					{/if}
				</Field.Field>

				<section class="flex flex-col gap-3" aria-label="Capture thoughts">
					<h2 class="font-medium">
						Thoughts
						{#if draft.document.thoughts.length}<span class="font-normal text-muted-foreground">{draft.document.thoughts.length}</span>{/if}
					</h2>

					{#if strandedEdit}
						<Alert.Root aria-label="Kept thought edit">
							<Alert.Title>Your edit to a thought was not applied</Alert.Title>
							<Alert.Description>The capture changed after you started editing, so it is unclear which thought this belongs to. Your text is kept here. Copy it, then edit the thought again.</Alert.Description>
							<Textarea
								aria-label="Kept thought text"
								readonly={held}
								bind:value={
									() => strandedEdit?.text ?? '',
									(value) => {
										// Only the edit this box shows: the one still stranded now.
										if (fieldsLive() && strandedEdit) draft.inputEditing(value, strandedEdit.id);
									}
								}
								rows={3}
								class="mt-2"
							/>
							<div class="mt-2 flex flex-wrap gap-2">
								<Button variant="outline" size="sm" onclick={() => copy(strandedEdit.text, 'Text')}>Copy text</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={held}
									onclick={() => {
										if (mounted && strandedEdit) draft.cancelEditing(strandedEdit.id);
									}}>Discard this edit</Button
								>
							</div>
						</Alert.Root>
					{/if}

					{#if draft.document.thoughts.length}
						{#key draft.document.thoughts}
							<ol bind:this={thoughtList} aria-label="Thoughts" class="list-decimal divide-y border-y pl-6 marker:text-muted-foreground">
								{#each draft.document.thoughts as thought, index (index)}
									{@const shown = draft.document.thoughts}
									<li class="py-1 pl-1">
										{#if draft.editing !== undefined && draft.editing.thoughts === draft.document.thoughts && draft.editing.index === index}
											{@const edit = draft.editing}
											<!-- One form per edit: a new edit, even of this same thought, gets a new form. -->
											{#key edit.id}
												<ThoughtEditForm
													{draft}
													{edit}
													{held}
													eligible={fieldsLive}
													onSaved={() => void focusThought(index)}
													onCancelled={() => void focusThought(index)}
												/>
											{/key}
										{:else}
											<div class="flex items-start gap-2">
												<p class="min-w-0 flex-1 whitespace-pre-wrap break-words py-1.5 leading-relaxed {thought ? '' : 'text-muted-foreground'}">{thought || 'Empty thought'}</p>
												<DropdownMenu.Root>
													<DropdownMenu.Trigger>
														{#snippet child({ props })}
															<Button {...props} variant="ghost" size="sm" class="text-muted-foreground" aria-label="Thought actions" data-thought-actions>Actions</Button>
														{/snippet}
													</DropdownMenu.Trigger>
													<DropdownMenu.Content align="end" class="w-48" onCloseAutoFocus={onMenuClosed}>
														<DropdownMenu.Item disabled={held || draft.editing !== undefined} onclick={() => {
															if (!fieldsLive()) return;
															draft.startEditing(index, shown);
															// The editor takes focus as it appears; the menu must not take it back.
															afterMenu = () => {};
														}}>Edit</DropdownMenu.Item>
														<DropdownMenu.Item disabled={held || index === 0} onclick={() => move(index, index - 1, shown)}>Move up</DropdownMenu.Item>
														<DropdownMenu.Item disabled={held || index === draft.document.thoughts.length - 1} onclick={() => move(index, index + 1, shown)}>Move down</DropdownMenu.Item>
														<DropdownMenu.Separator />
														<DropdownMenu.Item onclick={() => copy(thought, 'Thought')}>Copy text</DropdownMenu.Item>
														<DropdownMenu.Separator />
														<DropdownMenu.Item variant="destructive" disabled={held} onclick={() => confirmDeleteThought(thought, index, shown)}>Delete thought…</DropdownMenu.Item>
													</DropdownMenu.Content>
												</DropdownMenu.Root>
											</div>
										{/if}
									</li>
								{/each}
							</ol>
						{/key}
					{/if}

					<form onsubmit={(event) => {
						event.preventDefault();
						if (!fieldsLive()) return;
						draft.addThought();
						newThoughtField?.focus();
					}} class="flex flex-col gap-2">
						<Field.Field>
							<Field.Label for="new-thought">Add a thought</Field.Label>
							<Textarea
								id="new-thought"
								bind:ref={newThoughtField}
								readonly={held}
								bind:value={
									() => draft.newThought,
									(value) => {
										if (fieldsLive()) draft.inputNewThought(value);
									}
								}
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
								{:else if draft.document.thoughts.length}
									Ctrl or ⌘ + Enter adds it after the last thought.
								{:else if draft.document.hasSection}
									Thoughts you add are saved in this capture, under its Thoughts heading.
								{:else}
									This file has no Thoughts section yet. Adding a thought appends one.
								{/if}
							</p>
							<Button type="submit" size="sm" disabled={held}>Add thought</Button>
						</div>
					</form>

					{#if draft.document.hasOtherContent}
						<p class="text-muted-foreground">This file has more Markdown after its thoughts. It is kept as it is, and shown in Source.</p>
					{/if}
				</section>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="source" class="flex flex-col gap-4">
			{#if sourceOnly !== undefined}
				<Alert.Root aria-label="Source only">
					<Alert.Title>This capture can only be edited as Source</Alert.Title>
					<Alert.Description>
						<p>{sourceOnly}</p>
						{#if draft.reading.parseError}
							<ul class="list-disc pl-5">
								{#each draft.reading.parseError.diagnostics as diagnostic, index (index)}
									{#if diagnostic.message !== draft.reading.parseError.message}<li>{diagnostic.message}</li>{/if}
								{/each}
							</ul>
						{/if}
						Nothing was changed. The whole file is in Source, where you can edit it directly.
					</Alert.Description>
				</Alert.Root>
			{/if}
			<Field.Field>
				<Field.Label for="capture-source">Markdown source</Field.Label>
				<Field.Description>
					This is <code class="break-all">{draft.path}</code>. It saves exactly as you type, frontmatter included.
				</Field.Description>
				<Textarea
					id="capture-source"
					bind:ref={sourceField}
					readonly={held}
					bind:value={
						() => toTextarea(draft.source),
						(value) => {
							if (sourceLive()) draft.inputSource(value);
						}
					}
					rows={18}
					spellcheck={false}
					class="min-h-64 resize-y font-mono"
				/>
			</Field.Field>
			{#if draft.status === 'invalid'}
				<Alert.Root aria-label="Needs repair">
					<Alert.Title>This file needs repair</Alert.Title>
					<Alert.Description>
						<p>{draft.rowProblem}</p>
						<p>It is saved as you type it, so you can fix it here. The Capture tab becomes available once it is a valid capture.</p>
					</Alert.Description>
				</Alert.Root>
			{/if}
		</Tabs.Content>
	</Tabs.Root>

	<Dialog.Root bind:open={() => draft.deletionReview !== undefined, (open) => { if (!open) cancelDeletion(); }}>
		<Dialog.Content class="sm:max-w-xl">
			<Dialog.Header>
				<Dialog.Title>Permanently delete this capture file?</Dialog.Title>
				<Dialog.Description>This is the saved file as it is now. Its thoughts are part of it and go with it. Recorded earlier versions remain in Git history.</Dialog.Description>
			</Dialog.Header>
			<div class="flex min-w-0 flex-col gap-3">
				{#if draft.hasUnsentInput || draft.notice !== undefined}<p class="font-medium">Text in this window that is not saved will be discarded too.</p>{/if}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex: the preview scrolls, so the keyboard must reach it -->
				<pre aria-label="Saved file" role="region" tabindex="0" class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs">{draft.deletionReview?.entry.text}</pre>
				{#if draft.deletionReview?.problem}<p role="status">{draft.deletionReview.problem}</p>{/if}
			</div>
			<Dialog.Footer>
				<Button variant="outline" disabled={draft.removing} onclick={cancelDeletion}>Cancel</Button>
				<Button variant="destructive" disabled={!mayDelete} onclick={confirmDeletion}>{draft.removing ? 'Deleting…' : 'Permanently delete'}</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
