<!--
	One capture as the timeline edits it: its text and its thoughts. It never
	shows the file's complete text; Files does, through the same draft.

	When the accepted text stops reading as a capture while this view is
	open, the view stays, with the draft's save state, and says why. Its text
	and thought controls go away rather than show values the file does not
	have, and Open in Files is the way to repair it.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Field from '@epicenter/ui/field';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import type { Captures } from '$lib/captures.svelte.js';
	import { copyText } from '$lib/download.js';
	import type { Draft } from '$lib/draft.svelte.js';
	import { Textarea } from '@epicenter/ui/textarea';
	import CaptureActions from './CaptureActions.svelte';
	import DraftRecovery from './DraftRecovery.svelte';
	import TechnicalDetails from './TechnicalDetails.svelte';
	import ThoughtEditForm from './ThoughtEditForm.svelte';

	let {
		draft: given,
		captures,
		focusNewThought = false,
		onBack,
		onDeleted,
		onOpen,
		onFiles,
	}: {
		/** The draft this view is for, for its whole lifetime; another draft mounts another view. */
		draft: Draft;
		captures: Captures;
		/** The capture was just added: the next thing to type is a thought. */
		focusNewThought?: boolean;
		onBack: () => void;
		/** Completion belongs to the app container even after deletion removes this view. */
		onDeleted: (stem: string) => void;
		onOpen: (stem: string) => void;
		/** Show this capture's file in Files: the way to edit its complete text. */
		onFiles: (stem: string) => void;
	} = $props();

	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	/**
	 * The draft this view was mounted for. Read once: while a parent's keyed
	 * block takes this view down, its prop already names the next draft, or
	 * none, and this view must not act for it.
	 */
	const draft = untrack(() => given);
	const stem = draft.stem;

	/**
	 * Cleared on destroy, for this view's commands. Each text box also has its
	 * own lifetime (`Textarea`): a block inside this view can go and come back
	 * while the view stays, and its old text box must not write again.
	 */
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});

	const capturedAt = $derived.by(() => {
		const value = draft.reading.fields.capturedAt;
		if (value === undefined) return undefined;
		const time = new Date(value);
		return Number.isNaN(time.getTime()) ? undefined : time;
	});
	// A thought edit whose thought is no longer in the document as shown.
	const strandedEdit = $derived(
		draft.editing !== undefined && draft.document.thoughts !== draft.editing.thoughts
			? draft.editing
			: undefined,
	);
	/** Nothing a person does is taken: leaving, deleting, or another operation holds it. */
	const held = $derived(!draft.admitted);

	// Bindings read this owner's current input. Menu and delayed commands also
	// check that this view is alive and its text still reads as a capture.
	const fieldsLive = () => mounted && draft.loaded && draft.problem === undefined;

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
	<div class="flex flex-col gap-4">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<h1 class="mr-auto basis-full text-lg font-semibold tracking-tight sm:basis-auto">
				{#if capturedAt}
					<time datetime={capturedAt.toISOString()}>{when.format(capturedAt)}</time>
				{:else}
					Capture with no date
				{/if}
			</h1>
			<Button variant="outline" size="sm" onclick={() => {
				if (mounted) onFiles(stem);
			}}>Open in Files</Button>
			<CaptureActions {draft} {captures} {onDeleted} />
		</div>

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

		{#if draft.problem !== undefined}
			<!-- The draft keeps its text and save state; only Files edits text that does not read as a capture. -->
			<Alert.Root variant="destructive" aria-label="Needs repair">
				<Alert.Title>This capture cannot be edited here until its file is repaired</Alert.Title>
				<Alert.Description>
					<p>{draft.problem}</p>
					{#if draft.reading.parseError}
						<ul class="list-disc pl-5">
							{#each draft.reading.parseError.diagnostics as diagnostic, index (index)}
								{#if diagnostic.message !== draft.reading.parseError.message}<li>{diagnostic.message}</li>{/if}
							{/each}
						</ul>
					{/if}
					<p>Nothing was changed. Your text and its save state stay with this capture. <code class="break-all">{draft.path}</code> can be edited in Files.</p>
					{#if draft.hasUnsentInput}<p>A thought you have not added yet is kept here, and comes back once the file reads as a capture.</p>{/if}
				</Alert.Description>
				<div class="mt-2 text-foreground"><Button size="sm" onclick={() => {
					if (mounted) onFiles(stem);
				}}>Open in Files</Button></div>
			</Alert.Root>
		{:else}
			<div class="flex flex-col gap-8">
				<Field.Field>
					<Field.Label for="capture-text">Capture text</Field.Label>
					<Textarea
						id="capture-text"
						readonly={held}
						bind:value={
							() => draft.text,
							draft.inputText
						}
						rows={rowsFor(draft.text)}
						class="max-h-96 resize-y leading-relaxed"
						placeholder="Write here…"
					/>
					<p class="text-sm text-muted-foreground">Changes that cannot be applied return to the current text. Open the file in Files to write unfinished Markdown.</p>
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
									draft.inputNewThought
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
									No Thoughts section is readable here. Check the file in Files before adding a new section.
								{/if}
							</p>
							<Button type="submit" size="sm" disabled={held}>Add thought</Button>
						</div>
					</form>

					{#if draft.document.hasOtherContent}
						<p class="text-muted-foreground">This file has more Markdown after its thoughts. It is kept as it is, and shown in Files.</p>
					{/if}
				</section>
			</div>
		{/if}
	</div>
{/if}
