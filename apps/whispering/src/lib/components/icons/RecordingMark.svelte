<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import studioMicrophone from '$lib/assets/studio-microphone.png';

	// The app identity mark: a pragmatic studio-microphone image (vendor emoji
	// artwork, not owned art) that gives the brand a face Lucide controls do not.
	// See ADR-0013. Decorative everywhere it renders (the hero and the sidebar
	// brand both sit next to a visible "Whispering" label), so `alt=""`.
	let { class: className }: { class?: string } = $props();
</script>

<img src={studioMicrophone} alt="" class={cn('object-contain', className)} />
