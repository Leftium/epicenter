<script lang="ts">
	import * as Select from '@epicenter/ui/select';

	let {
		value,
		providers,
		onValueChange,
	}: {
		value: string;
		providers: readonly string[];
		onValueChange: (provider: string) => void;
	} = $props();
</script>

<Select.Root type="single" {value} {onValueChange}>
	<Select.Trigger size="sm" class="flex-1">
		{value || 'Select provider…'}
	</Select.Trigger>
	<Select.Content>
		{#each providers as p (p)}
			<Select.Item value={p} label={p} />
		{/each}
	</Select.Content>
</Select.Root>
