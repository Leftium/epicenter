<script lang="ts">
	import { workspace } from '$lib/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	const handle = $derived(workspace.documents.skills.instructions.get(skillId));

	// Keep the sync transport live while this editor is mounted. The framework
	// refcounts binds per guid and disconnects after a grace period once the
	// last bind is released — so switching skills releases the old one and
	// binds the new atomically.
	$effect(() => {
		return handle.bind();
	});
</script>

<CodeMirrorEditor ytext={handle.binding} />
