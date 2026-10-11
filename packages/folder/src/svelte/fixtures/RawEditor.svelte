<script lang="ts">
	let { value = $bindable() }: { value: string } = $props();
</script>

<textarea aria-label="Markdown source" bind:value></textarea>
