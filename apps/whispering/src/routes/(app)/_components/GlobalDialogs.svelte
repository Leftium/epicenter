<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import MoreDetailsDialog from '$lib/components/MoreDetailsDialog.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';
</script>

<!--
	App-wide singleton dialogs. Each is driven by a module-level store, so this
	component mounts them once for the whole app. It lives at the session root,
	outside the responsive nav branch, so resizing across the breakpoint never
	tears a dialog down mid-interaction.
-->
<ConfirmationDialog />
<MoreDetailsDialog />
<UpdateDialog />
