<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PinIcon from '@lucide/svelte/icons/pin';
	import { folderLabel, instantNow, type NoteFields } from '$lib/data.js';
	import { withFileNewlines } from '$lib/files.js';
	import { fieldDefaults } from '$lib/note-source.js';
	import type { FileSession } from '$lib/file-session.svelte.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import DraftStatus from './DraftStatus.svelte';
	import { confirmDelete } from './file-actions.js';
	import NoteHistory from './NoteHistory.svelte';
	import RichEditor from './RichEditor.svelte';

	let { notes, session }: { notes: Notes; session: FileSession } = $props();

	const inspect = $derived(notes.host.folder.tables.notes.inspect);
	/**
	 * How the draft reads, by the notes table's own interpreter. Every control
	 * and every message below describes the text on screen, saved or not, and
	 * never the file as it was last saved.
	 */
	const draft = $derived(inspect(session.buffer));
	const fields = $derived(draft.fields);
	const title = $derived(fields.title ?? '');
	const pinned = $derived(fields.pinned === true);
	/** The folder this draft names. `null` is no folder; an id may be the empty string. */
	const folderId = $derived(fields.folderId ?? null);
	const deleted = $derived(typeof fields.deletedAt === 'string');
	// A draft that does not parse has no fields to edit; its source does.
	const fieldsEditable = $derived(draft.parseError === undefined);
	const defaults = $derived(fieldDefaults(draft, instantNow()));

	/** Which view of the one draft is showing. Switching saves nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');
	let historyOpen = $state(false);

	function patch(changes: Partial<NoteFields>) {
		void notes.patchNote(session.path, changes, { save: 'later' });
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
			disabled={!fieldsEditable}
			oninput={(event) => patch({ title: event.currentTarget.value })}
		/>
		<select
			class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
			aria-label="Folder"
			disabled={!fieldsEditable}
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
			disabled={!fieldsEditable}
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

	<DraftStatus
		{session}
		noun="note"
		onRecover={() => notes.recoverDraft(session.path)}
		onDiscard={() => notes.discardDraft(session.path)}
	/>

	{#if draft.parseError}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{draft.parseError.message}. Fix it in Source.
				{#if tab !== 'source'}
					<Button size="xs" variant="outline" onclick={() => (tab = 'source')}>Edit Source</Button>
				{/if}
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each draft.parseError.diagnostics as diagnostic, index (index)}
					{#if diagnostic.message !== draft.parseError.message}<li>{diagnostic.message}</li>{/if}
				{/each}
			</ul>
		</div>
	{:else if draft.issues.length > 0}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				Some fields need fixing. The rest of the note still works.
				{#if defaults}
					<Button size="xs" variant="outline" onclick={() => patch(defaults)}>Set these fields to their defaults</Button>
				{/if}
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each draft.issues as issue, index (index)}
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
		<RichEditor {session} {inspect} focusRequest={notes.focusRequest} onOpenSource={() => (tab = 'source')} />
	</div>
	{#if tab === 'source'}
		<div class="flex min-h-0 flex-1 flex-col p-3">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				value={session.buffer}
				aria-label="Markdown source"
				spellcheck={false}
				oninput={(event) => session.input(withFileNewlines(event.currentTarget.value, session.buffer))}
			/>
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<code class="font-mono">{session.path}</code>
		<div class="ml-auto flex items-center gap-1">
			{#if deleted}
				<Button
					size="sm"
					variant="outline"
					disabled={!fieldsEditable}
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
						if (!fieldsEditable) return void confirmDelete(notes, session.path);
						const problem = await notes.trashNote(session.path);
						if (problem) toast.error('Could not delete the note', { description: problem });
					}}
				>
					{fieldsEditable ? 'Move to Recently Deleted' : 'Delete file'}
				</Button>
			{/if}
		</div>
	</div>
</section>

{#if notes.host.history && historyOpen}
	<NoteHistory history={notes.host.history} {session} bind:open={historyOpen} />
{/if}
