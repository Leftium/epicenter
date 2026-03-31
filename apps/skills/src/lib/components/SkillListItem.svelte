<script lang="ts">
	import type { Skill } from '@epicenter/skills';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import { skillsState } from '$lib/state/skills-state.svelte';

	let { skill }: { skill: Skill } = $props();

	const isSelected = $derived(skillsState.selectedSkillId === skill.id);
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				class="flex w-full flex-col items-start gap-0.5 rounded-sm px-3 py-2 text-left hover:bg-accent/50 {isSelected
					? 'bg-accent text-accent-foreground'
					: ''}"
				onclick={() => skillsState.selectSkill(skill.id)}
				role="option"
				aria-selected={isSelected}
			>
				<span class="font-mono text-sm font-medium">{skill.name}</span>
				<span class="max-w-full truncate text-xs text-muted-foreground">
					{skill.description}
				</span>
			</button>
		{/snippet}
	</ContextMenu.Trigger>
	<ContextMenu.Content>
		<ContextMenu.Item onclick={() => skillsState.startRename(skill.id)}>
			Rename
			<ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
		</ContextMenu.Item>
		<ContextMenu.Item
			class="text-destructive"
			onclick={() => {
				skillsState.selectSkill(skill.id);
				skillsState.openDelete();
			}}
		>
			Delete
			<ContextMenu.Shortcut>⌫</ContextMenu.Shortcut>
		</ContextMenu.Item>
	</ContextMenu.Content>
</ContextMenu.Root>
