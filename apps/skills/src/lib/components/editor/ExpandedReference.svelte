<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { referenceDocs } from '$lib/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();

	const doc = fromDisposableCache(referenceDocs, () => id);
</script>

<div class="h-48 border-t">
	<CodeMirrorEditor ytext={doc.current.content.binding} />
</div>
