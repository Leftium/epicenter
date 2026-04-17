<script lang="ts">
	import { autocompletion } from '@codemirror/autocomplete';
	import type { FileId } from '@epicenter/filesystem';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { workspace } from '$lib/client';
	import { fsState } from '$lib/state/fs-state.svelte';
	import { opensidian } from '$lib/workspace/definition';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';
	import { linkDecorations } from './extensions/link-decorations';
	import { wikilinkAutocomplete } from './extensions/wikilink-autocomplete';

	let {
		fileId,
	}: {
		fileId: FileId;
	} = $props();
	const filename = $derived(fsState.getFile(fileId)?.name ?? 'untitled.md');
	const isMarkdown = $derived(
		filename.endsWith('.md') || !filename.includes('.'),
	);

	let content = $state<any>(null);

	const sharedLinkDecorations = linkDecorations({
		onNavigate: (ref) => fsState.selectFile(ref.id as FileId),
		resolveTitle: (ref) => fsState.getFile(ref.id as FileId)?.name ?? null,
	});

	const extensions = $derived(
		isMarkdown
			? [
					sharedLinkDecorations,
					wikilinkAutocomplete({
						workspaceId: opensidian.id,
						tableName: 'files',
						getFiles: () =>
							workspace.tables.files
								.getAllValid()
								.filter((r) => r.type === 'file')
								.map((r) => ({ id: r.id, name: r.name })),
					}),
				]
			: [sharedLinkDecorations, autocompletion()],
	);

	$effect(() => {
		const id = fileId;
		content = null;
		workspace.documents.files.content.open(id).then((openedContent: any) => {
			// Guard against race condition — if file changed while loading, ignore
			if (fsState.activeFileId !== id) return;
			content = openedContent;
		});
	});
</script>

{#if content}
	<CodeMirrorEditor ytext={content.asText()} {extensions} {filename} />
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
