<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { instructionsDocs } from '@epicenter/skills';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	const doc = fromDisposableCache(instructionsDocs, () => skillId);
</script>

<CodeMirrorEditor ytext={doc.current.instructions.binding} />
