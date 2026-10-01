<script lang="ts">
	import { readSource } from '@epicenter/folder';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PinIcon from '@lucide/svelte/icons/pin';
	import { instantNow, type NoteEntry, type NoteFields } from '$lib/data.js';
	import { withFileNewlines } from '$lib/files.js';
	import { missingFields } from '$lib/note-source.js';
	import type { FileSession } from '$lib/file-session.svelte.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import DraftStatus from './DraftStatus.svelte';
	import { confirmDelete } from './file-actions.js';
	import NoteHistory from './NoteHistory.svelte';
	import RichEditor from './RichEditor.svelte';

	let {
		notes,
		session,
		entry,
	}: {
		notes: Notes;
		session: FileSession;
		/** The listed row, or undefined when the file left the folder. */
		entry: NoteEntry | undefined;
	} = $props();

	/** The draft's interpretation, for the structured controls. */
	const parsed = $derived(readSource(session.buffer));
	const values = $derived(parsed.values);
	const title = $derived(typeof values?.title === 'string' ? values.title : '');
	const pinned = $derived(values?.pinned === true);
	const folderId = $derived(typeof values?.folderId === 'string' ? values.folderId : '');
	const deleted = $derived(typeof values?.deletedAt === 'string');
	const fieldsEditable = $derived(values !== undefined && parsed.body !== undefined);
	const missing = $derived(missingFields(session.buffer, instantNow()));

	/** Which view of the one draft is showing. Switching saves nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');
	let historyOpen = $state(false);

	function patch(fields: Partial<NoteFields>) {
		void notes.patchNote(session.path, fields, { save: 'later' });
	}

	const folderName = (id: string) =>
		notes.folders.find((folder) => folder.stem === id)?.fields.name ?? id;
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
			value={folderId}
			onchange={(event) => patch({ folderId: event.currentTarget.value || null })}
		>
			<option value="">No folder</option>
			{#each notes.folders as folder (folder.path)}
				<option value={folder.stem}>{folder.fields.name ?? folder.stem}</option>
			{/each}
			{#if folderId !== '' && !notes.folders.some((folder) => folder.stem === folderId)}
				<option value={folderId}>{folderName(folderId)} (missing)</option>
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

	{#if entry?.issues || parsed.issues.length > 0}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				The file stays saved as written. Fix it in Source.
				{#if missing}
					<Button size="xs" variant="outline" onclick={() => patch(missing)}>Add the missing fields</Button>
				{/if}
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#if parsed.issues.length > 0}
					{#each parsed.issues as issue, index (index)}
						<li>{issue.message}</li>
					{/each}
				{:else}
					{#each entry?.issues ?? [] as issue, index (index)}
						<li>{issue.kind === 'field' ? `${issue.field}: ` : ''}{issue.message}</li>
					{/each}
				{/if}
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
		<RichEditor {session} focusRequest={notes.focusRequest} onOpenSource={() => (tab = 'source')} />
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
