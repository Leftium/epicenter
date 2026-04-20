<script lang="ts">
	import { workspace } from '$lib/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	const handle = $derived(workspace.documents.skills.instructions.get(skillId));
</script>

<CodeMirrorEditor ytext={handle.binding} />
