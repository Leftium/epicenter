<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Tabs from '@epicenter/ui/tabs';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PinIcon from '@lucide/svelte/icons/pin';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { folderLabel, honeycrispDefinition, instantNow } from '$lib/data.js';
	import { inspectRow } from '@epicenter/folder';
	import { fieldDefaults, repairFields, withBody } from '$lib/note-source.js';
	import { problemsOf, type NoteEditor } from '$lib/note-editor.svelte.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import Lifetime from './Lifetime.svelte';
	import NoteHistory from './NoteHistory.svelte';
	import RichEditor from './RichEditor.svelte';
	import RowDraftStatus from './RowDraftStatus.svelte';

	let { notes, editor }: { notes: Notes; editor: NoteEditor } = $props();

	/*
	 * Every getter, setter, and handler below reads `editor` when it runs: a
	 * rename or a recovery hands this view a new editor, and the view, with
	 * its undo history, stays mounted. Shared Input and Textarea retire their
	 * value bindings when destroyed. `Lifetime` guards native select events
	 * and commands from conditional blocks, including after that kind of block
	 * mounts again. A setter composes the whole note from the editor's row
	 * as it is at that event. A note the editor refuses changes nothing, so
	 * the control shows the editor's value again.
	 */

	/** The note's one input, as its row editor holds it. */
	const row = $derived(editor.row);
	/** The structured note, when its fields show. */
	const note = $derived(row.status === 'valid' && !editor.rawMode ? row : undefined);
	const pinned = $derived(note?.fields.pinned === true);
	/** The folder this note names. `null` is no folder; an id may be the empty string. */
	const folderId = $derived(note?.fields.folderId ?? null);
	const deleted = $derived(typeof note?.fields.deletedAt === 'string');
	/** What the file view offers for text whose fields need values, read from the text on screen. */
	const defaults = $derived.by(() => {
		if (row.status === 'valid') return undefined;
		return fieldDefaults(inspectRow(honeycrispDefinition.tables.notes, row.text), instantNow());
	});

	/** Which view of the structured note shows. Switching saves nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');
	let historyOpen = $state(false);

	/** Textareas report LF; the setters restore the file's own line endings. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');

	/** `command`, run only while the block it belongs to lives. */
	const within = (live: () => boolean, command: () => unknown) => () => {
		if (live()) void command();
	};

	function showFile(on: boolean) {
		const problem = editor.showFile(on);
		if (problem)
			toast.error(on ? 'Could not show the file' : 'Could not open it as a note', { description: problem });
	}

	function fillDefaults() {
		if (editor.row.status !== 'invalid' || defaults === undefined) return;
		const { data: repaired, error } = repairFields(editor.row.text, defaults);
		if (error !== null) return void toast.error('Could not set the fields', { description: error });
		const problem = editor.setText(repaired);
		if (problem) editor.refuse(problem);
	}

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if note}
		<Lifetime>
			{#snippet children(live)}
				<div class="flex items-center gap-2 border-b px-3 py-2">
					<Input
						class="flex-1 text-base font-medium"
						bind:value={
							() => (editor.row.status === 'valid' ? (editor.row.fields.title ?? '') : ''),
							(title) => {
								if (editor.row.status !== 'valid') return;
								const problem = editor.set({ ...editor.row, fields: { ...editor.row.fields, title } });
								if (problem) editor.refuse(problem);
							}
						}
						placeholder="Title"
						aria-label="Title"
					/>
					<select
						class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
						aria-label="Folder"
						value={optionOf(folderId)}
						onchange={(event) => {
							if (!live() || editor.row.status !== 'valid') return;
							const problem = editor.set({
								...editor.row,
								fields: { ...editor.row.fields, folderId: idOf(event.currentTarget.value) },
							});
							if (problem) editor.refuse(problem);
						}}
					>
						<option value="">No folder</option>
						{#each notes.folders as folder (folder.path)}
							<option value={optionOf(folder.stem)}>{folderLabel(folder)}</option>
						{/each}
						{#if folderId !== null && !notes.folders.some((folder) => folder.stem === folderId)}
							<option value={optionOf(folderId)}>{folderId} (missing)</option>
						{/if}
					</select>
					<Button
						variant={pinned ? 'secondary' : 'ghost'}
						size="icon-sm"
						aria-label={pinned ? 'Unpin' : 'Pin'}
						aria-pressed={pinned}
						tooltip={pinned ? 'Unpin' : 'Pin'}
						onclick={within(live, () => {
							if (editor.row.status !== 'valid') return;
							const problem = editor.set({
								...editor.row,
								fields: { ...editor.row.fields, pinned: editor.row.fields.pinned !== true },
							});
							if (problem) editor.refuse(problem);
						})}
					>
						<PinIcon class={pinned ? 'fill-current' : ''} />
					</Button>
					{#if notes.host.history}
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="History"
							tooltip="Git history of this note"
							onclick={within(live, () => (historyOpen = true))}
						>
							<HistoryIcon />
						</Button>
					{/if}
				</div>
			{/snippet}
		</Lifetime>
	{/if}

	<RowDraftStatus
		{editor}
		onStopTracking={() => notes.stopTracking(editor.path)}
		onRecover={() => notes.recoverDraft(editor.path)}
	/>

	{#if note}
		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
			<Tabs.List class="mx-3">
				<Tabs.Trigger value="rich">Rich text</Tabs.Trigger>
				<Tabs.Trigger value="source">Source</Tabs.Trigger>
			</Tabs.List>
			<!-- The rich-text view stays mounted while Source shows, so its undo history
			     survives a look at the source that changes nothing. -->
			<Tabs.Content value="rich" forceMount class="min-h-0 flex-1">
				<RichEditor
					{editor}
					focusRequest={notes.focusRequest}
					onOpenSource={() => (tab = 'source')}
				/>
			</Tabs.Content>
			<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col">
				<div class="flex min-h-0 flex-1 flex-col p-3">
					<Textarea
						class="min-h-40 flex-1 resize-none font-mono text-xs"
						bind:value={
							() => lf(editor.row.status === 'valid' ? editor.row.body : ''),
							(value) => {
								if (editor.row.status !== 'valid') return;
								editor.set(withBody(editor.row, withFileNewlines(value, editor.row.body)));
							}
						}
						aria-label="Markdown source"
						spellcheck={false}
					/>
				</div>
			</Tabs.Content>
		</Tabs.Root>
	{:else}
		<!-- The whole file: for text that does not read as a note, and for keys the fields do not show. -->
		<Lifetime>
			{#snippet children(live)}
				<div class="border-b px-4 py-2 text-xs {row.status === 'invalid' ? 'bg-destructive/5' : ''}">
					<p class="flex flex-wrap items-center gap-2 font-medium">
						{#if row.status === 'invalid'}
							<Badge variant="destructive">Needs repair</Badge>
							This text does not read as a note yet. Fix it below; it saves as it is.
							{#if defaults}
								<Button size="xs" variant="outline" disabled={!editor.admitting} onclick={within(live, fillDefaults)}>
									Set the missing fields to their defaults
								</Button>
							{/if}
						{:else}
							This note is open as a file.
						{/if}
						<Button
							size="xs"
							variant="outline"
							disabled={row.status !== 'valid'}
							onclick={within(live, () => showFile(false))}
						>
							Open as note
						</Button>
					</p>
					{#if row.status === 'invalid'}
						<ul class="mt-1 space-y-0.5 text-muted-foreground">
							{#each problemsOf(row.error) as problem, index (index)}
								<li>{problem}</li>
							{/each}
						</ul>
					{/if}
				</div>
				<div class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
					<Textarea
						class="min-h-40 flex-1 resize-none font-mono text-xs"
						bind:value={
							() => lf(editor.row.text),
							(value) => {
								const problem = editor.setText(withFileNewlines(value, editor.row.text));
								if (problem) editor.refuse(problem);
							}
						}
						aria-label="Contents of {editor.path}"
						spellcheck={false}
					/>
				</div>
			{/snippet}
		</Lifetime>
	{/if}

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<code class="font-mono">{editor.path}</code>
		{#if note}
			<Lifetime>
				{#snippet children(live)}
					<Button
						size="sm"
						variant="ghost"
						tooltip="Edit the whole file as text, including keys Honeycrisp does not show"
						onclick={within(live, () => showFile(true))}
					>
						Edit as file
					</Button>
				{/snippet}
			</Lifetime>
		{/if}
		<div class="ml-auto flex items-center gap-1">
			{#if deleted}
				<Lifetime>
					{#snippet children(live)}
						<Button
							size="sm"
							variant="outline"
							onclick={within(live, async () => {
								const problem = await notes.restoreNote(editor.path);
								if (problem) toast.error('Could not restore the note', { description: problem });
							})}
						>
							Restore
						</Button>
					{/snippet}
				</Lifetime>
			{:else if note}
				<Lifetime>
					{#snippet children(live)}
						<Button
							size="sm"
							variant="ghost-destructive"
							onclick={within(live, async () => {
								const problem = await notes.trashNote(editor.path);
								if (problem) toast.error('Could not delete the note', { description: problem });
							})}
						>
							Move to Recently Deleted
						</Button>
					{/snippet}
				</Lifetime>
			{/if}
			{#if deleted || row.status === 'invalid'}
				<Lifetime>
					{#snippet children(live)}
						<Button
							size="sm"
							variant="ghost-destructive"
							onclick={within(live, () => confirmDelete(notes, editor.path))}
						>
							Delete permanently
						</Button>
					{/snippet}
				</Lifetime>
			{/if}
		</div>
	</div>
</section>

{#if notes.host.history && historyOpen}
	{@const history = notes.host.history}
	<Lifetime>
		{#snippet children(live)}
			<NoteHistory
				{history}
				path={editor.path}
				admitting={editor.admitting}
				onUse={(source) => (live() ? notes.useVersion(editor, source) : 'This history view was closed.')}
				bind:open={historyOpen}
			/>
		{/snippet}
	</Lifetime>
{/if}
