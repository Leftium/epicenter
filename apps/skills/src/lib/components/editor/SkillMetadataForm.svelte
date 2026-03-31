<script lang="ts">
	import type { Skill } from '@epicenter/skills';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toast } from 'svelte-sonner';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import { validateSkill } from '$lib/utils/validation';

	let { skill }: { skill: Skill } = $props();

	let name = $state(skill.name);
	let description = $state(skill.description);
	let license = $state(skill.license ?? '');
	let compatibility = $state(skill.compatibility ?? '');
	let errors = $state<string[]>([]);
	let isDirty = $state(false);

	function markDirty() {
		isDirty = true;
		errors = validateSkill({ name, description, license, compatibility });
	}

	function handleSave() {
		const validationErrors = validateSkill({ name, description, license, compatibility });
		if (validationErrors.length > 0) {
			errors = validationErrors;
			toast.error('Fix validation errors before saving');
			return;
		}

		skillsState.updateSkill(skill.id, {
			name,
			description,
			...(license ? { license } : { license: undefined }),
			...(compatibility ? { compatibility } : { compatibility: undefined }),
		});

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
				<Badge variant="destructive">
					{errors.length} error{errors.length > 1 ? 's' : ''}
				</Badge>
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
			<Field.Description>Lowercase, hyphens only (1–64 chars)</Field.Description>
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
		<Field.Description>Which agents/tools this skill targets (optional, ≤500 chars)</Field.Description>
	</Field.Field>

	{#if errors.length > 0}
		<div class="space-y-1">
			{#each errors as error}
				<Field.Error>{error}</Field.Error>
			{/each}
		</div>
	{/if}
</div>
