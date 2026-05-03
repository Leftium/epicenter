<script lang="ts">
	import { autocompletion } from '@codemirror/autocomplete';
	import type { FileId } from '@epicenter/filesystem';
	import { fromDocumentFamily } from '@epicenter/svelte';
	import { Spinner } from '@epicenter/ui/spinner';
	import { opensidian } from '$lib/opensidian/client';
	import { fsState } from '$lib/state/fs-state.svelte';
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

	const doc = fromDocumentFamily(opensidian.fileContentDocs, () => fileId);

	const sharedLinkDecorations = linkDecorations({
		onNavigate: (ref) => fsState.selectFile(ref.id as FileId),
		resolveTitle: (ref) => fsState.getFile(ref.id as FileId)?.name ?? null,
	});

	const extensions = $derived(
		isMarkdown
			? [
					sharedLinkDecorations,
					wikilinkAutocomplete({
						workspaceId: opensidian.ydoc.guid,
						tableName: 'files',
						getFiles: () =>
							opensidian.tables.files
								.getAllValid()
								.filter((r) => r.type === 'file')
								.map((r) => ({ id: r.id, name: r.name })),
					}),
				]
			: [sharedLinkDecorations, autocompletion()],
	);
</script>

<!--
	Gate on whenReady: `asText()` on Timeline mutates when the doc is empty
	(it pushes an entry). Calling it before persistence hydrates races the
	IDB replay and can corrupt the timeline (phantom text entry alongside
	the real stored entries).
-->
{#await doc.current.whenReady}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	<CodeMirrorEditor
		ytext={doc.current.content.asText()}
		{extensions}
		{filename}
	/>
{/await}
