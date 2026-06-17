<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Label } from '@epicenter/ui/label';
	import { Switch } from '@epicenter/ui/switch';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UnlinkIcon from '@lucide/svelte/icons/unlink';
	import ReferenceDatabase from './ReferenceDatabase.svelte';
	import { createReferencesDemo } from './references-demo.svelte';

	// In-memory three-table vault (pages -> adaptations -> publications) run through the real
	// readFolder + checkReferences pipeline. Nothing touches disk. Open at /demo/references.
	const demo = createReferencesDemo();
</script>

<svelte:head><title>Matter / references demo</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-5xl flex-col gap-5 p-4">
	<header class="flex flex-wrap items-center gap-3">
		<Badge variant="outline">demo</Badge>
		<h1 class="text-sm font-semibold">Row-level references</h1>
		<span class="text-xs text-muted-foreground">
			Relations colored by the real <span class="font-mono">checkReferences</span> verdict. Nothing
			touches disk.
		</span>
	</header>

	<!-- Summary strip: the validator's counts at a glance. -->
	<div class="flex flex-wrap gap-2">
		<div class="flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
			<span class="font-mono text-sm font-semibold">{demo.counts.total}</span>
			<span class="text-muted-foreground">references</span>
		</div>
		<div class="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
			<CircleCheckIcon class="size-4 text-emerald-600 dark:text-emerald-400" />
			<span class="font-mono text-sm font-semibold">{demo.counts.resolved}</span>
			<span class="text-muted-foreground">resolved</span>
		</div>
		<div class="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
			<TriangleAlertIcon class="size-4 text-destructive" />
			<span class="font-mono text-sm font-semibold">{demo.counts.dangling}</span>
			<span class="text-muted-foreground">dangling</span>
		</div>
		<div class="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
			<UnlinkIcon class="size-4 text-amber-600 dark:text-amber-400" />
			<span class="font-mono text-sm font-semibold">{demo.counts.missingTarget}</span>
			<span class="text-muted-foreground">missing target</span>
		</div>

		<div class="ml-auto flex items-center gap-2 rounded-md border px-3 py-2">
			<Switch
				id="include-pages"
				checked={demo.includePages}
				onCheckedChange={(value) => (demo.includePages = value)}
			/>
			<Label for="include-pages" class="text-xs">Load <span class="font-mono">pages</span> folder</Label>
		</div>
	</div>

	<p class="text-xs text-muted-foreground">
		Toggle the <span class="font-mono">pages</span> folder off to drop a reference target: every
		<span class="font-mono">adaptations.page</span> relation flips from resolved to
		<span class="text-amber-600 dark:text-amber-400">missing target</span> — the validator's
		distinction between a gone table and a gone row.
	</p>

	{#each demo.folders as folder (folder.name)}
		<ReferenceDatabase table={folder.name} read={folder.read} cellFor={demo.cellFor} />
	{/each}

	<!-- Findings panel: the authoritative checkReferences output, distinct kinds kept distinct. -->
	<section class="rounded-lg border">
		<header class="border-b px-3 py-2">
			<h2 class="text-sm font-semibold">
				checkReferences findings
				<Badge variant={demo.report.findings.length ? 'destructive' : 'secondary'} class="ml-1">
					{demo.report.findings.length}
				</Badge>
			</h2>
		</header>
		{#if demo.report.findings.length === 0}
			<p class="px-3 py-3 text-xs text-emerald-600 dark:text-emerald-400">
				Every reference resolves to an existing row.
			</p>
		{:else}
			<ul class="divide-y text-xs">
				{#each demo.report.findings as finding, i (i)}
					<li class="flex items-center gap-2 px-3 py-2">
						{#if finding.kind === 'MISSING_TARGET'}
							<Badge variant="outline" class="border-amber-500/40 text-amber-600 dark:text-amber-400">
								MISSING_TARGET
							</Badge>
							<span class="font-mono">{finding.table}.{finding.field}</span>
							<span class="text-muted-foreground">
								→ target table "{finding.target}" not loaded
							</span>
						{:else}
							<Badge variant="destructive">UNRESOLVED</Badge>
							<span class="font-mono">{finding.table}/{finding.file}</span>
							<span class="text-muted-foreground">
								{finding.field} = "{finding.value}" → no row in "{finding.target}"
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>
