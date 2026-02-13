<script lang="ts">
	import TabList from '$lib/components/TabList.svelte';
	import SuspendedTabList from '$lib/components/SuspendedTabList.svelte';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Separator } from '@epicenter/ui/separator';
	import * as Tooltip from '@epicenter/ui/tooltip';
</script>

<Tooltip.Provider>
	<main
		class="w-[400px] min-h-[300px] max-h-[600px] overflow-hidden bg-background text-foreground"
	>
		<header
			class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 px-4 py-3"
		>
			<h1 class="text-lg font-semibold">Tab Manager</h1>
		</header>
		<ScrollArea class="h-[calc(600px-60px)]">
			<TabList />
			<Separator class="my-2" />
			<SuspendedTabList />
		</ScrollArea>
	</main>
</Tooltip.Provider>
