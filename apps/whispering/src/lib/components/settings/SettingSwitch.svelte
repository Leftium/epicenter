<script lang="ts" generics="K extends BooleanSettingKey">
	import * as Field from '@epicenter/ui/field';
	import { Switch } from '@epicenter/ui/switch';
	import {
		type BooleanSettingKey,
		settings,
	} from '$lib/state/settings.svelte';

	let { key, label }: { key: K; label: string } = $props();

	// Opaque, generated id wired into both `for` and `id` from one source. The
	// id has no external consumer, so it carries no meaning by design: there is
	// nothing to keep in sync with the setting key, and nothing to drift.
	const id = $props.id();
</script>

<Field.Field orientation="horizontal">
	<Field.Label for={id}>{label}</Field.Label>
	<Switch
		{id}
		bind:checked={() => settings.get(key), (checked) => settings.set(key, checked)}
	/>
</Field.Field>
