<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button } from '@epicenter/ui/button';
	import { skillsState } from '$lib/state/skills-state.svelte';

	const skillName = $derived(skillsState.selectedSkill?.name ?? 'this skill');
</script>

<AlertDialog.Root
	open={skillsState.deleteDialogOpen}
	onOpenChange={(isOpen) => {
		if (!isOpen) skillsState.closeDelete();
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {skillName}?</AlertDialog.Title>
			<AlertDialog.Description>
				This will delete the skill and all its references. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button
				variant="destructive"
				onclick={() => {
					if (skillsState.selectedSkillId) {
						skillsState.deleteSkill(skillsState.selectedSkillId);
					}
				}}
			>
				Delete
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
