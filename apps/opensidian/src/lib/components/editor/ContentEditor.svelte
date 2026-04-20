<script lang="ts">
	import { autocompletion } from '@codemirror/autocomplete';
	import type { FileId } from '@epicenter/filesystem';
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

	const handle = $derived(workspace.documents.files.content.get(fileId));

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
</script>

<CodeMirrorEditor ytext={handle.asText()} {extensions} {filename} />
