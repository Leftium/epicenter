<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Collapsible from '@epicenter/ui/collapsible';

	// A failure exactly as the folder or Git reported it. It is kept whole for
	// diagnosis and stays closed, so the choices beside it are read first.
	let { detail }: { detail: string } = $props();

	let open = $state(false);
</script>

<Collapsible.Root bind:open class="mt-2 text-foreground">
	<Collapsible.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="link" size="xs" class="h-auto p-0">{open ? 'Hide' : 'Show'} technical details</Button>
		{/snippet}
	</Collapsible.Trigger>
	<Collapsible.Content>
		<pre class="mt-1 whitespace-pre-wrap break-all rounded-md border bg-background p-2 text-xs">{detail}</pre>
	</Collapsible.Content>
</Collapsible.Root>
