<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { Separator } from '@epicenter/ui/separator';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { toast } from 'svelte-sonner';
	import { fsState } from '$lib/state/fs-state.svelte';
	import { createSkillTemplate, validateSkill } from '$lib/types';
	import { fs, ws } from '$lib/client';

	let seeding = $state(false);
	let newSkillOpen = $state(false);
	let newSkillName = $state('');
	let newSkillError = $state('');
	let searchQuery = $state('');
	let searchResults = $state<
		Array<{ id: string; name: string; path: string | null; snippet: string }>
	>([]);
	let isSearching = $state(false);

	async function handleCreateSkill() {
		const name = newSkillName.trim();
		if (!name) return;

		// Validate the name
		const errors = validateSkill({
			name,
			description: 'TODO—describe when and why to use this skill.',
		});
		const nameErrors = errors.filter((e) => e.includes('name'));
		if (nameErrors.length > 0) {
			newSkillError = nameErrors[0] ?? 'Invalid name';
			return;
		}

		try {
			await fs.mkdir(`/${name}`);
			await fs.writeFile(`/${name}/SKILL.md`, createSkillTemplate(name));
			toast.success(`Created skill: ${name}`);
			newSkillOpen = false;
			newSkillName = '';
			newSkillError = '';
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : 'Failed to create skill',
			);
			console.error(err);
		}
	}

	async function handleSearch() {
		const query = searchQuery.trim();
		if (!query) {
			searchResults = [];
			return;
		}
		isSearching = true;
		try {
			searchResults = await ws.extensions.sqliteIndex.search(query);
		} catch (err) {
			console.error('Search failed:', err);
			searchResults = [];
		} finally {
			isSearching = false;
		}
	}

	// Debounced search
	$effect(() => {
		const query = searchQuery;
		const timer = setTimeout(() => {
			handleSearch();
		}, 300);
		return () => clearTimeout(timer);
	});

	async function loadSampleSkill() {
		seeding = true;
		try {
			await fs.mkdir('/example-skill');
			await fs.writeFile(
				'/example-skill/SKILL.md',
				createSkillTemplate('example-skill'),
			);
			await fs.mkdir('/example-skill/references');
			await fs.writeFile(
				'/example-skill/references/patterns.md',
				'# Patterns\n\nReference material for the example skill.\n',
			);
			toast.success('Loaded sample skill');
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : 'Failed to load sample skill',
			);
			console.error(err);
		} finally {
			seeding = false;
		}
	}
</script>

<Tooltip.Provider>
	<div class="flex items-center gap-1 border-b px-2 py-1.5">
		<Dialog.Root bind:open={newSkillOpen}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="sm" onclick={() => (newSkillOpen = true)}>
							New Skill
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Create a new skill with SKILL.md template</Tooltip.Content>
			</Tooltip.Root>
			<Dialog.Content class="max-w-sm">
				<Dialog.Header>
					<Dialog.Title>New Skill</Dialog.Title>
					<Dialog.Description>
						Creates a skill folder with a SKILL.md template.
					</Dialog.Description>
				</Dialog.Header>
				<div class="space-y-2 py-2">
					<Label>Skill Name</Label>
					<Input
						bind:value={newSkillName}
						placeholder="my-skill"
						class="font-mono"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								handleCreateSkill();
							}
						}}
					/>
					{#if newSkillError}
						<p class="text-sm text-destructive">{newSkillError}</p>
					{/if}
					<p class="text-xs text-muted-foreground">
						Lowercase, hyphens only (1–64 chars)
					</p>
				</div>
				<Dialog.Footer>
					<Button variant="outline" onclick={() => (newSkillOpen = false)}
						>Cancel</Button
					>
					<Button onclick={handleCreateSkill} disabled={!newSkillName.trim()}
						>Create</Button
					>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>

		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						onclick={() => fsState.startCreate('file')}
					>
						New File
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content
				>Create a new file in the selected folder</Tooltip.Content
			>
		</Tooltip.Root>

		<Separator orientation="vertical" class="mx-1 h-4" />

		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						onclick={() => {
							if (fsState.activeFileId) fsState.startRename(fsState.activeFileId);
						}}
						disabled={!fsState.activeFileId}
					>
						Rename
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Rename selected item</Tooltip.Content>
		</Tooltip.Root>

		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						onclick={() => {
							if (fsState.activeFileId) fsState.openDelete();
						}}
						disabled={!fsState.activeFileId}
					>
						Delete
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Delete selected item</Tooltip.Content>
		</Tooltip.Root>

		<Separator orientation="vertical" class="mx-1 h-4" />

		<div class="relative">
			<Input
				bind:value={searchQuery}
				placeholder="Search skills..."
				class="h-7 w-48 text-xs"
			/>
			{#if isSearching}
				<Spinner
					class="absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
				/>
			{/if}
		</div>

		<div class="ml-auto flex items-center gap-1">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							onclick={loadSampleSkill}
							disabled={seeding}
						>
							{#if seeding}
								<Spinner class="size-3.5" />
							{:else}
								Load Sample
							{/if}
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content
					>Load a sample skill to explore the editor</Tooltip.Content
				>
			</Tooltip.Root>
		</div>
	</div>
</Tooltip.Provider>
