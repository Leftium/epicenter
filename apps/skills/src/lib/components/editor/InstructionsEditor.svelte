<script lang="ts">
	import { fromDocumentFamily } from '@epicenter/svelte';
	import { skills } from '$lib/skills/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	const doc = fromDocumentFamily(skills.instructionsDocs, () => skillId);
</script>

<CodeMirrorEditor ytext={doc.current.instructions.binding} />
