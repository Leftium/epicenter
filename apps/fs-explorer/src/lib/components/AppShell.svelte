<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import FileTree from './FileTree.svelte';
	import Toolbar from './Toolbar.svelte';
	import ContentPanel from './ContentPanel.svelte';
</script>

<div class="flex h-screen flex-col">
	<Toolbar />
	<Resizable.PaneGroup direction="horizontal" class="flex-1">
		<Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
			<ScrollArea class="h-full">
				<div class="p-2">
					<FileTree />
				</div>
			</ScrollArea>
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={75}>
			<ContentPanel />
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>
