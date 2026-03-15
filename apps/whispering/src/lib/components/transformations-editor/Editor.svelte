<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { workspaceTransformationRuns } from '$lib/state/workspace-transformation-runs.svelte';
	import type { TransformationStep } from '$lib/state/workspace-transformation-steps.svelte';
	import type { Transformation } from '$lib/state/workspace-transformations.svelte';
	import Configuration from './Configuration.svelte';
	import Runs from './Runs.svelte';
	import Test from './Test.svelte';

	let {
		transformation = $bindable(),
		steps = $bindable(),
	}: {
		transformation: Transformation;
		steps: Omit<TransformationStep, '_v'>[];
	} = $props();

	const runs = $derived(
		workspaceTransformationRuns.getByTransformationId(transformation.id),
	);
</script>

<Resizable.PaneGroup direction="horizontal">
	<Resizable.Pane>
		<Configuration bind:transformation bind:steps />
	</Resizable.Pane>
	<Resizable.Handle withHandle />
	<Resizable.Pane>
		<Resizable.PaneGroup direction="vertical">
			<Resizable.Pane> <Test {transformation} {steps} /> </Resizable.Pane>
			<Resizable.Handle withHandle />
			<Resizable.Pane> <Runs {runs} /> </Resizable.Pane>
		</Resizable.PaneGroup>
	</Resizable.Pane>
</Resizable.PaneGroup>
