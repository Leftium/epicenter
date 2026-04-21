<script lang="ts">
	import { instructionsDocs } from '$lib/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	// Parent (SkillEditor) wraps in {#key selectedSkillId}, so skillId is
	// stable for this instance's lifetime. Open once, dispose on unmount.
	const handle = instructionsDocs.open(skillId);
	$effect(() => () => handle.dispose());
</script>

<CodeMirrorEditor ytext={handle.instructions.binding} />
