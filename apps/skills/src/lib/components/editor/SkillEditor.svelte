<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import InstructionsEditor from './InstructionsEditor.svelte';
	import ReferencesPanel from './ReferencesPanel.svelte';
	import SkillMetadataForm from './SkillMetadataForm.svelte';
</script>

<div class="flex h-full flex-col">
	{#if skillsState.selectedSkillId && skillsState.selectedSkill}
		<ScrollArea class="flex-1">
			{#key skillsState.selectedSkillId}
				<SkillMetadataForm skill={skillsState.selectedSkill} />
			{/key}
			<div class="h-[50vh] min-h-64">
				{#key skillsState.selectedSkillId}
					<InstructionsEditor skillId={skillsState.selectedSkillId} />
				{/key}
			</div>
			{#key skillsState.selectedSkillId}
				<ReferencesPanel />
			{/key}
		</ScrollArea>
	{:else}
		<Empty.Root class="h-full border-0">
			<Empty.Header>
				<Empty.Title>No skill selected</Empty.Title>
				<Empty.Description>Select a skill from the sidebar to edit</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{/if}
</div>
