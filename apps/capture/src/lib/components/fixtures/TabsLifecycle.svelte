<script lang="ts">
	import { Input } from '@epicenter/ui/input';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';

	let { forceMount = false, read, write }: {
		forceMount?: boolean;
		read: () => string;
		write: (value: string) => void;
	} = $props();
</script>

<Tabs.Root value="first">
	<Tabs.List>
		<Tabs.Trigger value="first">First</Tabs.Trigger>
		<Tabs.Trigger value="second">Second</Tabs.Trigger>
	</Tabs.List>
	<Tabs.Content value="first" {forceMount}>
		<Input aria-label="Field" bind:value={() => read(), value => write(value)} />
		<Textarea aria-label="Body" bind:value={() => read(), value => write(value)} />
	</Tabs.Content>
	<Tabs.Content value="second">
		{#snippet child({ props })}
			<section {...props}>Second panel</section>
		{/snippet}
	</Tabs.Content>
</Tabs.Root>
