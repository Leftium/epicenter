<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PinIcon from '@lucide/svelte/icons/pin';
	import { folderLabel, type NoteFields } from '$lib/data.js';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { noteBody } from '$lib/note-source.js';
	import type { NoteSession, Notes } from '$lib/notes.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import NoteHistory from './NoteHistory.svelte';
	import RichEditor from './RichEditor.svelte';
	import RowDraftStatus from './RowDraftStatus.svelte';

	let { notes, session }: { notes: Notes; session: NoteSession } = $props();

	/**
	 * The body every view of this note edits. It follows `session`, which a
	 * rename replaces, so the views and their undo history stay mounted.
	 */
	const draft = noteBody(() => session);
	/**
	 * How the draft reads. Every control and every message below describes the
	 * document on screen, saved or not, and never the file as last saved.
	 */
	const reading = $derived(session.state.reading);
	const fields = $derived(reading.fields);
	const title = $derived(fields.title ?? '');
	const pinned = $derived(fields.pinned === true);
	/** The folder this draft names. `null` is no folder; an id may be the empty string. */
	const folderId = $derived(fields.folderId ?? null);
	const deleted = $derived(typeof fields.deletedAt === 'string');

	/** Which view of the one draft is showing. Switching saves nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');
	let historyOpen = $state(false);

	function patch(changes: Partial<NoteFields>) {
		void notes.patchNote(session.path, changes, { save: 'later' });
	}

	async function editAsFile() {
		const problem = await notes.editAsFile(session.path);
		if (problem) toast.error('Could not open the file as text', { description: problem });
	}

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	<div class="flex items-center gap-2 border-b px-3 py-2">
		<Input
			class="flex-1 text-base font-medium"
			value={title}
			placeholder="Title"
			aria-label="Title"
			oninput={(event) => patch({ title: event.currentTarget.value })}
		/>
		<select
			class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
			aria-label="Folder"
			value={optionOf(folderId)}
			onchange={(event) => patch({ folderId: idOf(event.currentTarget.value) })}
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
			onclick={() => patch({ pinned: !pinned })}
		>
			<PinIcon class={pinned ? 'fill-current' : ''} />
		</Button>
		{#if notes.host.history}
			<Button variant="ghost" size="icon-sm" aria-label="History" tooltip="Git history of this note" onclick={() => (historyOpen = true)}>
				<HistoryIcon />
			</Button>
		{/if}
	</div>

	<RowDraftStatus
		{session}
		onDiscard={() => notes.discardDraft(session.path)}
		onStopTracking={() => notes.stopTracking(session.path)}
	/>

	{#if reading.issues.length > 0}
		<!-- Input the note cannot save stays on screen; saving waits until it is fixed. -->
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Not saved</Badge>
				Some fields need fixing before this note can be saved.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each reading.issues as issue, index (index)}
					<li>{issue.message}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="flex items-center gap-1 border-b px-3 py-1.5" role="tablist" aria-label="View">
		<Button
			size="xs"
			variant={tab === 'rich' ? 'secondary' : 'ghost'}
			role="tab"
			aria-selected={tab === 'rich'}
			onclick={() => (tab = 'rich')}
		>
			Rich text
		</Button>
		<Button
			size="xs"
			variant={tab === 'source' ? 'secondary' : 'ghost'}
			role="tab"
			aria-selected={tab === 'source'}
			onclick={() => (tab = 'source')}
		>
			Source
		</Button>
		<span class="ml-auto text-xs text-muted-foreground">Both views edit one draft</span>
	</div>

	<!-- The rich-text view stays mounted while Source shows, so its undo history
	     survives a look at the source that changes nothing. -->
	<div class="min-h-0 flex-1" hidden={tab !== 'rich'}>
		<RichEditor {draft} admitting={session.admitting} focusRequest={notes.focusRequest} onOpenSource={() => (tab = 'source')} />
	</div>
	{#if tab === 'source'}
		<div class="flex min-h-0 flex-1 flex-col p-3">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				value={draft.body}
				aria-label="Markdown source"
				spellcheck={false}
				oninput={(event) => draft.input(withFileNewlines(event.currentTarget.value, draft.body))}
			/>
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<code class="font-mono">{session.path}</code>
		<Button size="sm" variant="ghost" tooltip="Edit the whole file as text, including keys Honeycrisp does not show" onclick={editAsFile}>
			Edit as file
		</Button>
		<div class="ml-auto flex items-center gap-1">
			{#if deleted}
				<Button
					size="sm"
					variant="outline"
							onclick={async () => {
						const problem = await notes.restoreNote(session.path);
						if (problem) toast.error('Could not restore the note', { description: problem });
					}}
				>
					Restore
				</Button>
				<Button size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(notes, session.path)}>
					Delete permanently
				</Button>
			{:else}
				<Button
					size="sm"
					variant="ghost-destructive"
					onclick={async () => {
						const problem = await notes.trashNote(session.path);
						if (problem) toast.error('Could not delete the note', { description: problem });
					}}
				>
					Move to Recently Deleted
				</Button>
			{/if}
		</div>
	</div>
</section>

{#if notes.host.history && historyOpen}
	<NoteHistory
		history={notes.host.history}
		path={session.path}
		admitting={session.admitting}
		onUse={(source) => notes.useVersion(session, source)}
		bind:open={historyOpen}
	/>
{/if}
