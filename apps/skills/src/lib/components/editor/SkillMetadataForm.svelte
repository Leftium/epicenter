<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import {
		parseFrontmatter,
		serializeMarkdownWithFrontmatter,
	} from '@epicenter/filesystem';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toast } from 'svelte-sonner';
	import { fsState } from '$lib/state/fs-state.svelte';
	import { type SkillFrontmatter, validateSkill } from '$lib/types';
	import { fs } from '$lib/client';

	let {
		fileId,
	}: {
		fileId: FileId;
	} = $props();

	let name = $state('');
	let description = $state('');
	let license = $state('');
	let compatibility = $state('');
	let originalName = $state('');
	let errors = $state<string[]>([]);
	let isDirty = $state(false);

	// Load frontmatter when fileId changes
	$effect(() => {
		const id = fileId;
		loadFrontmatter(id);
	});

	async function loadFrontmatter(id: FileId) {
		const content = await fsState.readContent(id);
		if (!content) return;

		const parsed = parseFrontmatter(content);
		const fm = parsed.frontmatter as SkillFrontmatter;

		name = fm.name ?? '';
		description = fm.description ?? '';
		license = fm.license ?? '';
		compatibility = fm.compatibility ?? '';
		originalName = fm.name ?? '';
		errors = [];
		isDirty = false;
	}

	function markDirty() {
		isDirty = true;
		// Live validation
		errors = validateSkill({ name, description, license, compatibility });
	}

	async function handleSave() {
		const frontmatter: SkillFrontmatter = { name, description };
		if (license) frontmatter.license = license;
		if (compatibility) frontmatter.compatibility = compatibility;

		const validationErrors = validateSkill(frontmatter);
		if (validationErrors.length > 0) {
			errors = validationErrors;
			toast.error('Fix validation errors before saving');
			return;
		}

		// Read current content to preserve body
		const content = await fsState.readContent(fileId);
		if (!content) return;

		const parsed = parseFrontmatter(content);

		// Merge frontmatter—preserve any extra fields from the original
		const mergedFrontmatter = {
			...(parsed.frontmatter as Record<string, unknown>),
			name,
			description,
			...(license ? { license } : {}),
			...(compatibility ? { compatibility } : {}),
		};

		const newContent = serializeMarkdownWithFrontmatter(
			mergedFrontmatter,
			parsed.body,
		);
		await fsState.writeContent(fileId, newContent);

		// Enforce folder name = name field
		if (name !== originalName && originalName) {
			const currentPath = fsState.selectedPath;
			if (currentPath) {
				// Get the skill folder path (parent of SKILL.md)
				const parentPath = currentPath.substring(
					0,
					currentPath.lastIndexOf('/'),
				);
				if (parentPath) {
					const newParentPath =
						parentPath.substring(0, parentPath.lastIndexOf('/') + 1) + name;
					try {
						await fs.mv(parentPath, newParentPath);
						toast.success(`Renamed skill folder to ${name}`);
					} catch (err) {
						toast.error('Failed to rename skill folder');
						console.error(err);
					}
				}
			}
			originalName = name;
		}

		isDirty = false;
		toast.success('Skill metadata saved');
	}

	const isValid = $derived(errors.length === 0);
</script>

<div class="space-y-4 border-b p-4">
	<div class="flex items-center justify-between">
		<h3 class="text-sm font-medium text-muted-foreground">Skill Metadata</h3>
		<div class="flex items-center gap-2">
			{#if errors.length > 0}
				<Badge variant="destructive"
					>{errors.length}
					error{errors.length > 1 ? 's' : ''}</Badge
				>
			{:else if isDirty}
				<Badge variant="secondary">Unsaved</Badge>
			{/if}
			<Button size="sm" onclick={handleSave} disabled={!isDirty || !isValid}>
				Save Metadata
			</Button>
		</div>
	</div>

	<div class="grid grid-cols-2 gap-4">
		<Field.Field>
			<Field.Label>Name</Field.Label>
			<Field.Content>
				<Input
					bind:value={name}
					oninput={markDirty}
					placeholder="my-skill"
					class="font-mono text-sm"
				/>
			</Field.Content>
			<Field.Description
				>Lowercase, hyphens only (1–64 chars)</Field.Description
			>
		</Field.Field>

		<Field.Field>
			<Field.Label>License</Field.Label>
			<Field.Content>
				<Input bind:value={license} oninput={markDirty} placeholder="MIT" />
			</Field.Content>
		</Field.Field>
	</div>

	<Field.Field>
		<Field.Label>Description</Field.Label>
		<Field.Content>
			<Textarea
				bind:value={description}
				oninput={markDirty}
				placeholder="Describe when and why to use this skill..."
				rows={2}
				class="resize-none"
			/>
		</Field.Content>
		<Field.Description>{description.length}/1024 characters</Field.Description>
	</Field.Field>

	<Field.Field>
		<Field.Label>Compatibility</Field.Label>
		<Field.Content>
			<Input
				bind:value={compatibility}
				oninput={markDirty}
				placeholder="Claude Code, OpenCode, Cursor..."
			/>
		</Field.Content>
		<Field.Description
			>Which agents/tools this skill targets (optional, ≤500 chars)</Field.Description
		>
	</Field.Field>

	{#if errors.length > 0}
		<div class="space-y-1">
			{#each errors as error}
				<Field.Error>{error}</Field.Error>
			{/each}
		</div>
	{/if}
</div>
