<script lang="ts">
	import { autocompletion } from '@codemirror/autocomplete';
	import type { FileId } from '@epicenter/filesystem';
	import { Spinner } from '@epicenter/ui/spinner';
	import { workspace } from '$lib/client.svelte';

	const { fileContentDocs } = workspace;
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

	// Parent (ContentPanel) wraps in {#key activeFileId}, so fileId is stable
	// for this instance's lifetime. Open once, dispose on unmount.
	const handle = fileContentDocs.open(fileId);
	let isLoaded = $state(false);

	// `asText()` on Timeline mutates when the doc is empty — it pushes an
	// entry. If called before persistence hydrates, it races the IDB replay
	// and can corrupt the timeline (phantom text entry alongside the real
	// stored entries). Gate on `whenReady` so we only read mode after the
	// doc has its real state.
	$effect(() => {
		let cancelled = false;
		handle.whenReady.then(() => {
			if (!cancelled) isLoaded = true;
		});
		return () => {
			cancelled = true;
			handle.dispose();
		};
	});

	const sharedLinkDecorations = linkDecorations({
		onNavigate: (ref) => fsState.selectFile(ref.id as FileId),
		resolveTitle: (ref) => fsState.getFile(ref.id as FileId)?.name ?? null,
	});

	const extensions = $derived(
		isMarkdown
			? [
					sharedLinkDecorations,
					wikilinkAutocomplete({
						workspaceId: workspace.id,
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

{#if isLoaded}
	<CodeMirrorEditor
		ytext={handle.content.asText()}
		{extensions}
		{filename}
	/>
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
