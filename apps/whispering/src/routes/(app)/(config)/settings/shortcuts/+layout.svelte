<script lang="ts">
	import * as SectionHeader from '@epicenter/ui/section-header';

	let { children } = $props();
</script>

<div class="mx-auto max-w-4xl space-y-6 py-6">
	<SectionHeader.Root>
		<SectionHeader.Title level={1} class="text-3xl">
			Keyboard Shortcuts
		</SectionHeader.Title>
		<SectionHeader.Description class="mt-2">
			Configure keyboard shortcuts to quickly access Whispering features.
		</SectionHeader.Description>
	</SectionHeader.Root>

	{@render children()}
</div>
