<script lang="ts">
	import { Input } from '@epicenter/ui/input';
	import { Separator } from '@epicenter/ui/separator';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import NewSkillDialog from './dialogs/NewSkillDialog.svelte';

	let searchQuery = $state('');
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
