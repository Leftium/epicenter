<script lang="ts">
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Link } from '@epicenter/ui/link';
	import { Separator } from '@epicenter/ui/separator';
	import Layers2Icon from '@lucide/svelte/icons/layers-2';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { desktopRpc, rpc } from '$lib/query';
	import { resetGlobalShortcuts } from '$routes/(app)/_layout-utils/register-commands';
	import ShortcutFormatHelp from '../keyboard-shortcut-recorder/ShortcutFormatHelp.svelte';
	import ShortcutTable from '../keyboard-shortcut-recorder/ShortcutTable.svelte';
</script>

<svelte:head> <title>Global Shortcuts - Whispering</title> </svelte:head>

{#if window.__TAURI_INTERNALS__}
	<section>
		<div
			class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
		>
			<header class="space-y-1">
				<div class="flex items-center gap-2">
					<h2 class="text-xl font-semibold tracking-tight sm:text-2xl">
						Global Shortcuts
					</h2>
					<ShortcutFormatHelp type="global" />
				</div>
				<p class="text-sm text-muted-foreground">
					Set system-wide keyboard shortcuts that work even when Whispering is
					not in focus. These shortcuts will trigger from anywhere on your
					system.
				</p>
			</header>
			<Button
				variant="outline"
				size="sm"
				onclick={async () => {
					await desktopRpc.globalShortcuts.unregisterAll();
					resetGlobalShortcuts();
					rpc.notify.success({
						title: 'Shortcuts reset',
						description: 'All global shortcuts have been reset to defaults.',
					});
				}}
				class="shrink-0"
			>
				<RotateCcw class="size-4" />
				Reset to defaults
			</Button>
		</div>

		<Separator class="my-6" />

		<ShortcutTable type="global" />
	</section>
{:else}
	<Empty.Root>
		<Empty.Header>
			<Empty.Media>
				<Layers2Icon class="size-10 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Global Shortcuts</Empty.Title>
			<Empty.Description>
				Global shortcuts allow you to use Whispering from any application on
				your computer. This feature is only available in the desktop app or
				browser extension.
			</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Link href="/desktop-app" class={buttonVariants()}>
				Enable Global Shortcuts
			</Link>
		</Empty.Content>
	</Empty.Root>
{/if}
