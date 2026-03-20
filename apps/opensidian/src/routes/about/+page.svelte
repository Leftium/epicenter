<script lang="ts">
	import * as Accordion from '@epicenter/ui/accordion';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Separator } from '@epicenter/ui/separator';
	import {
		ArrowLeft,
		ChevronRight,
		Database,
		FileText,
		GitBranch,
		HardDrive,
	} from '@lucide/svelte';
	import { codeToHtml } from 'shiki';

	const techBadges = [
		'Yjs CRDTs',
		'In-Browser SQLite',
		'IndexedDB',
		'Svelte 5',
		'CodeMirror 6',
	] as const;

	const capabilities = [
		{
			icon: GitBranch,
			title: 'CRDT Storage',
			description:
				'Every file row lives in a Yjs Y.Map. Create, rename, delete, move\u2014all conflict-free. No server needed.',
		},
		{
			icon: FileText,
			title: 'Per-File Documents',
			description:
				'Each file gets its own Y.Doc with a Y.Text instance. CodeMirror binds directly to it via y-codemirror.next. Collaborative editing is built in.',
		},
		{
			icon: HardDrive,
			title: 'IndexedDB Persistence',
			description:
				'The workspace persists all Y.Docs to IndexedDB automatically. Close the tab, reopen\u2014your notes are there.',
		},
		{
			icon: Database,
			title: 'In-Browser SQLite',
			description:
				'A WASM-based SQLite database indexes the file tree for O(1) parent\u2192children lookups. The tree view and command palette read from this index.',
		},
	] as const;

	const roadmap = [
		'Multi-device sync\u2014the workspace API already supports WebSocket sync via Yjs providers',
		'Markdown preview',
		'Full-text search',
		'Encryption',
	] as const;

	const workspaceCode = `import { createSqliteIndex, createYjsFileSystem, filesTable } from '@epicenter/filesystem';
import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';

export const ws = createWorkspace({
  id: 'opensidian',
  tables: { files: filesTable },
})
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqliteIndex', createSqliteIndex());

export const fs = createYjsFileSystem(ws.tables.files, ws.documents.files.content);`;

	const codeAnnotations = [
		{
			id: 'create-workspace',
			line: 'createWorkspace({ id, tables })',
			explanation:
				'Creates a Yjs workspace with a unique ID and a typed table schema. Each table becomes a Y.Map of rows inside a shared Y.Doc.',
		},
		{
			id: 'persistence',
			line: ".withExtension('persistence', indexeddbPersistence)",
			explanation:
				"Attaches IndexedDB persistence\u2014every Y.Doc update is written to the browser's local storage automatically.",
		},
		{
			id: 'sqlite-index',
			line: ".withWorkspaceExtension('sqliteIndex', createSqliteIndex())",
			explanation:
				'Spins up a WASM SQLite database that mirrors the Yjs table into SQL rows for fast tree queries.',
		},
		{
			id: 'filesystem',
			line: 'createYjsFileSystem(tables.files, documents.files.content)',
			explanation:
				'Wraps the raw table and document APIs into a familiar filesystem interface\u2014writeFile, mkdir, rm, mv.',
		},
	] as const;

	const footerLinks = [
		{
			href: 'https://github.com/EpicenterHQ/epicenter/tree/main/apps/opensidian',
			label: 'GitHub (OpenSidian)',
		},
		{
			href: 'https://github.com/EpicenterHQ/epicenter',
			label: 'Epicenter Project',
		},
		{
			href: 'https://go.epicenter.so/discord',
			label: 'Discord',
		},
	] as const;

	let highlightedCode = $state('');

	$effect(() => {
		codeToHtml(workspaceCode, {
			lang: 'typescript',
			themes: { light: 'github-light', dark: 'github-dark' },
			defaultColor: false,
		}).then((html) => {
			highlightedCode = html;
		});
	});
</script>

<style>
	:global(html.dark .shiki),
	:global(html.dark .shiki span) {
		color: var(--shiki-dark) !important;
		background-color: var(--shiki-dark-bg) !important;
	}

	:global(.shiki) {
		background-color: transparent !important;
	}
</style>

<div class="mx-auto max-w-3xl px-6 py-12">
	<!-- Back navigation -->
	<Button
		variant="ghost"
		size="sm"
		href="/"
		class="text-muted-foreground mb-8 gap-1.5"
	>
		<ArrowLeft class="size-3.5" />
		Back to editor
	</Button>

	<!-- Header -->
	<header>
		<h1 class="text-4xl font-extrabold tracking-tight">OpenSidian</h1>
		<p class="text-muted-foreground mt-2 text-lg">
			Open-source, local-first notes&mdash;built on CRDTs
		</p>
		<div class="mt-4 flex flex-wrap gap-2">
			{#each techBadges as label}
				<Badge variant="secondary">{label}</Badge>
			{/each}
		</div>
	</header>

	<Separator class="my-10" />

	<!-- How it works -->
	<section>
		<h2 class="text-2xl font-semibold tracking-tight">How it works</h2>
		<p class="text-muted-foreground mt-3 leading-relaxed">
			Every note is a Yjs document. Edits are CRDT operations&mdash;they merge
			automatically and never conflict. The Y.Doc persists to IndexedDB so your
			data survives page refreshes. A SQLite index (running in-browser via WASM)
			materializes the file tree for fast parent/child lookups.
		</p>
		<Card.Root class="mt-6">
			<Card.Content class="p-0">
				<pre
					class="text-muted-foreground overflow-x-auto p-6 font-mono text-sm leading-relaxed"
				>Your edits  &rarr;  Y.Doc (CRDT)  &rarr;  IndexedDB (persistence)
                       &darr;
                 SQLite Index (fast queries)
                       &darr;
                 File Tree + Search</pre>
			</Card.Content>
		</Card.Root>
	</section>

	<Separator class="my-10" />

	<!-- The entire data layer -->
	<section>
		<h2 class="text-2xl font-semibold tracking-tight">The entire data layer</h2>
		<p class="text-muted-foreground mt-3 leading-relaxed">
			The app is roughly 600 lines of code. The entire data layer is this one
			file&mdash;<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-sm"
				>src/lib/workspace.ts</code
			>:
		</p>
		<Card.Root class="mt-6 overflow-hidden">
			<Card.Content class="relative p-0">
				<div class="overflow-x-auto p-6 text-sm leading-relaxed">
					{#if highlightedCode}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html highlightedCode}
					{:else}
						<pre class="font-mono"><code>{workspaceCode}</code></pre>
					{/if}
				</div>
				<CopyButton
					text={workspaceCode}
					variant="ghost"
					size="icon-sm"
					class="absolute top-3 right-3 opacity-60 hover:opacity-100"
				/>
			</Card.Content>
		</Card.Root>
		<p class="text-muted-foreground mt-4 leading-relaxed">
			That's it. 10 lines. The workspace API handles the hard parts:
		</p>
		<Accordion.Root type="multiple" class="mt-4">
			{#each codeAnnotations as annotation}
				<Accordion.Item value={annotation.id}>
					<Accordion.Trigger class="py-2 text-sm">
						<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs"
							>{annotation.line}</code
						>
					</Accordion.Trigger>
					<Accordion.Content>
						<p class="text-muted-foreground pb-2 text-sm leading-relaxed">
							{annotation.explanation}
						</p>
					</Accordion.Content>
				</Accordion.Item>
			{/each}
		</Accordion.Root>
	</section>

	<Separator class="my-10" />

	<!-- What the workspace API provides -->
	<section>
		<h2 class="text-2xl font-semibold tracking-tight">
			What the workspace API provides
		</h2>
		<div class="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
			{#each capabilities as capability}
				<Card.Root>
					<Card.Header>
						<div class="flex items-center gap-2">
							<capability.icon class="text-muted-foreground size-4" />
							<Card.Title class="text-base">{capability.title}</Card.Title>
						</div>
					</Card.Header>
					<Card.Content>
						<p class="text-muted-foreground text-sm leading-relaxed">
							{capability.description}
						</p>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	</section>

	<Separator class="my-10" />

	<!-- What's next -->
	<section>
		<h2 class="text-2xl font-semibold tracking-tight">What's next</h2>
		<ul class="text-muted-foreground mt-4 space-y-2 text-sm leading-relaxed">
			{#each roadmap as item}
				<li class="flex items-start gap-2">
					<ChevronRight
						class="text-muted-foreground/50 mt-0.5 size-3.5 shrink-0"
					/>
					{item}
				</li>
			{/each}
		</ul>
	</section>

	<Separator class="my-10" />

	<!-- Footer -->
	<footer class="flex flex-wrap gap-2">
		{#each footerLinks as link}
			<Button
				variant="ghost"
				size="sm"
				href={link.href}
				target="_blank"
				rel="noopener noreferrer"
				class="text-muted-foreground"
			>
				{link.label}
			</Button>
		{/each}
	</footer>
</div>
