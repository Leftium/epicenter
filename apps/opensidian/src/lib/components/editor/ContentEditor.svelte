<script lang="ts">
	import { autocompletion } from '@codemirror/autocomplete';
	import type { FileId } from '@epicenter/filesystem';
	import { Spinner } from '@epicenter/ui/spinner';
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

	// `asText()` on Timeline mutates when the doc is empty — it pushes an
	// entry. If called before persistence hydrates, it races the IDB replay
	// and can corrupt the timeline (phantom text entry alongside the real
	// stored entries). Gate on `whenLoaded` so we only read mode after the
	// doc has its real state.
	const handle = $derived(workspace.documents.files.content.get(fileId));
	let loadedHandle = $state<typeof handle | null>(null);
	$effect(() => {
		const h = handle;
		loadedHandle = null;
		h.whenLoaded.then(() => {
			// Ignore the result if the user navigated away mid-load.
			if (h === handle) loadedHandle = h;
		});
	});

	// Keep the sync transport live while this editor is mounted. We bind the
	// outer `handle` (not `loadedHandle`) so sync starts hydrating remote
	// state in parallel with the local IDB load — both finish faster that way.
	$effect(() => {
		return handle.bind();
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

{#if loadedHandle}
	<CodeMirrorEditor ytext={loadedHandle.asText()} {extensions} {filename} />
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
