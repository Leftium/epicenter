<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import { workspace } from '$lib/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	let handle = $state<DocumentHandle | null>(null);

	$effect(() => {
		const id = skillId;
		handle = null;
		workspace.documents.skills.instructions.open(id).then((h) => {
			// Guard against race condition—if skill changed while loading, ignore
			if (skillsState.selectedSkillId !== id) return;
			handle = h;
		});
	});
</script>

{#if handle}
	<CodeMirrorEditor ytext={handle.asText()} />
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
