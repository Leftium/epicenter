<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Separator } from '@epicenter/ui/separator';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import NewSkillDialog from './dialogs/NewSkillDialog.svelte';

	let searchQuery = $state('');

	/**
	 * Filter skills reactively by name or description.
	 * Simple client-side filter—sufficient for ~50-100 skills.
	 */
	const filteredSkills = $derived.by(() => {
		const q = searchQuery.toLowerCase().trim();
		if (!q) return skillsState.skills;
		return skillsState.skills.filter(
			(s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
		);
	});
</script>

<Tooltip.Provider>
	<div class="flex items-center gap-1 border-b px-2 py-1.5">
		<NewSkillDialog />

		<Separator orientation="vertical" class="mx-1 h-4" />

		<div class="relative">
			<Input bind:value={searchQuery} placeholder="Search skills..." class="h-7 w-48 text-xs" />
		</div>
	</div>
</Tooltip.Provider>
