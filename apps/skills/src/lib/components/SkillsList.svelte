<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import SkillListItem from './SkillListItem.svelte';
	import InlineNameInput from './tree/InlineNameInput.svelte';

	const isEditing = $derived(skillsState.renamingSkillId !== null);

	function handleKeydown(e: KeyboardEvent) {
		if (isEditing) return;

		const skills = skillsState.skills;
		const idx = skillsState.selectedSkillId
			? skills.findIndex((s) => s.id === skillsState.selectedSkillId)
			: -1;

		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				const next = skills[idx + 1] ?? skills[0];
				if (next) skillsState.selectSkill(next.id);
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				const prev = skills[idx - 1] ?? skills.at(-1);
				if (prev) skillsState.selectSkill(prev.id);
				break;
			}
			case 'F2': {
				if (skillsState.selectedSkillId) skillsState.startRename(skillsState.selectedSkillId);
				break;
			}
			case 'Delete':
			case 'Backspace': {
				if (skillsState.selectedSkillId) skillsState.openDelete();
				break;
			}
		}
	}
</script>

{#if skillsState.skills.length === 0 && !isEditing}
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>No skills yet</Empty.Title>
			<Empty.Description>Use the toolbar to create a new skill</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<div role="listbox" aria-label="Skills" tabindex={0} onkeydown={handleKeydown}>
		{#each skillsState.skills as skill (skill.id)}
			{#if skillsState.renamingSkillId === skill.id}
				<InlineNameInput
					defaultValue={skill.name}
					onConfirm={(name) => skillsState.confirmRename(name)}
					onCancel={() => skillsState.cancelRename()}
				/>
			{:else}
				<SkillListItem {skill} />
			{/if}
		{/each}
	</div>
{/if}
