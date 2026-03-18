<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import CommandPalette from './CommandPalette.svelte';
	import ContentPanel from './editor/ContentPanel.svelte';
	import CreateDialog from './dialogs/CreateDialog.svelte';
	import DeleteConfirmation from './dialogs/DeleteConfirmation.svelte';
	import FileTree from './tree/FileTree.svelte';
	import RenameDialog from './dialogs/RenameDialog.svelte';
	import Toolbar from './Toolbar.svelte';
</script>

<div class="flex h-screen flex-col">
	<Toolbar />
	<Resizable.PaneGroup direction="horizontal" class="flex-1">
		<Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
			<ScrollArea class="h-full">
				<div class="p-2"><FileTree /></div>
			</ScrollArea>
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={75}> <ContentPanel /> </Resizable.Pane>
	</Resizable.PaneGroup>
	<CommandPalette />
</div>

<CreateDialog />
<RenameDialog />
<DeleteConfirmation />
