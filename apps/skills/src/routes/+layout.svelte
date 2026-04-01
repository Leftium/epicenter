<script lang="ts">
	import '../app.css';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from 'svelte-sonner';

	let { children } = $props();
</script>

<ConfirmationDialog />
<Toaster richColors />
{@render children()}
