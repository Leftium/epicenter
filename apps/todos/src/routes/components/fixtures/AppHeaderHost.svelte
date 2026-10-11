<!-- The header as the page mounts it: inside the tooltip provider the layout supplies. -->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Todos } from '$lib/todos.svelte.js';
	import AppHeader from '../AppHeader.svelte';

	let { todos }: { todos: Todos } = $props();
</script>

<Tooltip.Provider>
	<AppHeader {todos} filesOpen={false} terminalOpen={false} onToggleFiles={() => {}} onToggleTerminal={() => {}} />
</Tooltip.Provider>
