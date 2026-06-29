<script lang="ts">
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { sql } from '@codemirror/lang-sql';
	import { EditorState } from '@codemirror/state';
	import { EditorView, keymap, placeholder } from '@codemirror/view';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Table from '@epicenter/ui/table';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { untrack } from 'svelte';
	import { CONSOLE_LIMIT } from '$lib/mirror.svelte';
	import type { VaultHandle } from '$lib/vault.svelte';

	// The vault-wide read-only SQL console: run arbitrary SELECT / JOIN / GROUP BY against the vault's
	// hidden `.matter/matter.sqlite` and render the result verbatim. READ-ONLY by construction
	// (ADR-0065): the mirror opens the db read-only, so a write is rejected, and a JOIN or aggregate row
	// maps to no file, so nothing here edits a cell. Cmd/Ctrl+Enter or the Run button executes the
	// editor's text.
	let { vault, defaultTable }: { vault: VaultHandle; defaultTable?: string } =
		$props();

	let container: HTMLDivElement | undefined;
	// Plain handle (not reactive): the Run button reads the live document from it.
	let editorView: EditorView | undefined;
	let result = $state<{ columns: string[]; rows: unknown[][] }>();
	let error = $state<string>();
	let running = $state(false);
	let hasRun = $state(false);

	// A starting query the user edits: every column of the active table. With no table yet, list the
	// db's tables so even an empty vault shows something runnable. Seeded once at mount (read via
	// `untrack` in the effect), since the console mounts fresh for the active table.
	function initialQuery(): string {
		return defaultTable
			? `SELECT * FROM "${defaultTable}" LIMIT 100`
			: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";
	}

	async function run(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed || running) return;
		running = true;
		const { data, error: failure } = await vault.mirror.runSql(trimmed);
		running = false;
		hasRun = true;
		if (failure) {
			error = failure.message;
			result = undefined;
		} else {
			error = undefined;
			result = data;
		}
	}

	const consoleTheme = EditorView.theme({
		'&': {
			backgroundColor: 'transparent',
			color: 'hsl(var(--foreground))',
			fontSize: '13px',
		},
		'&.cm-focused': { outline: 'none' },
		'.cm-scroller': {
			fontFamily:
				'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
			lineHeight: '1.6',
			overflow: 'auto',
			maxHeight: '14rem',
		},
		'.cm-content': {
			minHeight: '4.5rem',
			padding: '0.75rem 1rem',
			caretColor: 'hsl(var(--foreground))',
		},
		'.cm-cursor': { borderLeftColor: 'hsl(var(--foreground))' },
		'.cm-gutters': { display: 'none' },
		'.cm-activeLine': { backgroundColor: 'transparent' },
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
			backgroundColor: 'hsl(var(--primary) / 0.18)',
		},
		'.cm-placeholder': { color: 'hsl(var(--muted-foreground))' },
	});

	$effect(() => {
		if (!container) return;
		const view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: untrack(initialQuery),
				extensions: [
					history(),
					keymap.of([
						{
							key: 'Mod-Enter',
							run: (current) => {
								void run(current.state.doc.toString());
								return true;
							},
						},
						...historyKeymap,
						...defaultKeymap,
					]),
					EditorView.lineWrapping,
					sql(),
					placeholder('SELECT * FROM ...'),
					consoleTheme,
				],
			}),
		});
		editorView = view;
		return () => {
			view.destroy();
			editorView = undefined;
		};
	});

	/** Render one non-null result cell: an object as compact JSON, everything else as text. NULL and
	 *  undefined never reach here, the template renders them as a faint dash. */
	function renderCell(value: unknown): string {
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	}

	// `runSql` fetches one row past CONSOLE_LIMIT: an overflow row is the capped signal. Render only the
	// first CONSOLE_LIMIT so a result that lands exactly on the limit is not misreported as capped.
	const capped = $derived(!!result && result.rows.length > CONSOLE_LIMIT);
	const rows = $derived(
		capped ? result!.rows.slice(0, CONSOLE_LIMIT) : (result?.rows ?? []),
	);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
		<div class="min-w-0">
			<h2 class="text-sm font-semibold">SQL console</h2>
			<p class="text-xs text-muted-foreground">
				Read-only SQL over {vault.folderName}'s database. Cmd+Enter to run.
			</p>
		</div>
		<Button
			size="sm"
			onclick={() => run(editorView?.state.doc.toString() ?? '')}
			disabled={running}
		>
			<PlayIcon />
			{running ? 'Running...' : 'Run'}
		</Button>
	</div>

	<div class="border-b bg-background" bind:this={container}></div>

	{#if error}
		<div
			class="border-b bg-destructive/5 px-4 py-2 font-mono text-xs text-destructive"
			role="alert"
		>
			{error}
		</div>
	{/if}

	<div class="flex-1 overflow-auto">
		{#if result}
			{#if rows.length === 0}
				<Empty.Root class="min-h-48 border-0">
					<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
					<Empty.Title>No rows</Empty.Title>
					<Empty.Description>The query ran but returned no rows.</Empty.Description>
				</Empty.Root>
			{:else}
				<div
					class="border-b px-4 py-1.5 text-xs text-muted-foreground"
					role="status"
				>
					{rows.length}
					{rows.length === 1 ? 'row' : 'rows'}{#if capped}, capped at the first {CONSOLE_LIMIT}{/if}
				</div>
				<Table.Root class="min-w-full">
					<Table.Header>
						<Table.Row>
							{#each result.columns as column, i (i)}
								<Table.Head class="sticky top-0 z-10 bg-background font-mono text-xs">
									{column}
								</Table.Head>
							{/each}
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each rows as row, r (r)}
							<Table.Row>
								{#each row as cell, c (c)}
									<Table.Cell class="max-w-80 truncate font-mono text-xs">
										{#if cell === null || cell === undefined}
											<span class="text-muted-foreground/50">.</span>
										{:else}
											{renderCell(cell)}
										{/if}
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		{:else if !hasRun}
			<Empty.Root class="min-h-48 border-0">
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>Run a query</Empty.Title>
				<Empty.Description>
					Cmd+Enter or Run executes read-only SQL. Try a JOIN across tables.
				</Empty.Description>
			</Empty.Root>
		{/if}
	</div>
</div>
