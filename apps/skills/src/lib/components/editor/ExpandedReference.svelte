<script lang="ts">
	import { referenceDocs } from '$lib/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();

	// Parent mounts via {#if expandedRefId === ref.id}, so id is stable for
	// this instance's lifetime. Open once, dispose on unmount.
	const handle = referenceDocs.open(id);
	$effect(() => () => handle.dispose());
</script>

<div class="h-48 border-t">
	<CodeMirrorEditor ytext={handle.content.binding} />
</div>
