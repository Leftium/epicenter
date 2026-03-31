<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import CommandPalette from './CommandPalette.svelte';
	import SkillEditor from './editor/SkillEditor.svelte';
	import SkillsList from './SkillsList.svelte';
	import StorageBadge from './StorageBadge.svelte';
	import Toolbar from './Toolbar.svelte';
</script>

<div class="flex h-screen flex-col">
	<Toolbar />
	<Resizable.PaneGroup direction="horizontal" class="flex-1">
		<Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
			<div class="flex h-full flex-col">
				<ScrollArea class="flex-1">
					<div class="p-2"><SkillsList /></div>
				</ScrollArea>
				<StorageBadge />
			</div>
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={75}>
			<SkillEditor />
		</Resizable.Pane>
	</Resizable.PaneGroup>
	<CommandPalette />
</div>

