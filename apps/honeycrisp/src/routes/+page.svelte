<script lang="ts">
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { openNotes } from '#platform/notes-host';
	import { onDestroy } from 'svelte';
	import { createNotes } from '$lib/notes.svelte.js';
	import NotesView from './components/NotesView.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	// On the desktop, closing the window or quitting asks this page first.
	const opening = openNotes({
		async create(host) {
			const notes = createNotes(host);
			await notes.check();
			return notes;
		},
		askToDiscard: (remaining) =>
			new Promise<boolean>((resolve) => {
				confirmationDialog.open({
					title: `${remaining} ${remaining === 1 ? 'change is' : 'changes are'} not saved or not confirmed`,
					description:
						'Some text could not be saved to its file, or a change was sent and never confirmed. Quitting now discards unsaved text and stops keeping track of the unconfirmed changes. It does not cancel them: one may still happen afterwards. Keep editing to retry, compare, or copy.',
					confirm: { text: 'Discard and quit', variant: 'destructive' },
					cancel: { text: 'Keep editing' },
					onConfirm: () => resolve(true),
					onCancel: () => resolve(false),
				});
			}),
		report: (cause) =>
			toast.error('Could not finish closing', {
				description: cause instanceof Error ? cause.message : String(cause),
			}),
	});

	onDestroy(() => {
		void opening.then((notes) => notes.close()).catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your notes…" />
{:then notes}
	<NotesView {notes} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the notes folder</Empty.Title>
		<Empty.Description>{error instanceof Error ? error.message : String(error)}</Empty.Description>
	</Empty.Root>
{/await}
