<script lang="ts">
	import { Tooltip as TooltipPrimitive } from 'bits-ui';

	let {
		delayDuration = 300,
		skipDelayDuration = 150,
		...restProps
	}: TooltipPrimitive.ProviderProps = $props();
</script>

<!--
	Opinionated defaults: 300ms delay, 150ms skip delay.
	bits-ui defaults to 700ms/300ms which feels sluggish for desktop apps.
	Individual Tooltip.Root components can override delayDuration via props.
	Nested providers (e.g. sidebar-provider with delayDuration={0}) override these defaults.
	See: https://bits-ui.com/docs/components/tooltip#provider-component
-->
<TooltipPrimitive.Provider {delayDuration} {skipDelayDuration} {...restProps} />
