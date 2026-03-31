import type { Skill } from '@epicenter/skills';
import { fromTable } from '@epicenter/svelte';
import { generateId } from '@epicenter/workspace';
import { workspace } from '$lib/client';

/**
 * Reactive skills state singleton.
 *
 * Follows the canonical monorepo pattern: factory function creates
 * `fromTable()` reactive maps, `$derived` arrays, and CRUD methods.
 * Components import the singleton and read directly.
 *
 * @example
 * ```svelte
 * <script>
 *   import { skillsState } from '$lib/state/skills-state.svelte';
 *   const skills = $derived(skillsState.skills);
 * </script>
 * ```
 */
function createSkillsState() {
	const skillsMap = fromTable(workspace.tables.skills);
	const referencesMap = fromTable(workspace.tables.references);

	const skills = $derived(
		skillsMap
			.values()
			.toArray()
			.sort((a, b) => a.name.localeCompare(b.name)),
	);

	let selectedSkillId = $state<string | null>(null);

	const selectedSkill = $derived(skillsMap.get(selectedSkillId ?? '') ?? null);

	const selectedReferences = $derived.by(() => {
		if (!selectedSkillId) return [];
		return referencesMap
			.values()
			.toArray()
			.filter((r) => r.skillId === selectedSkillId)
			.sort((a, b) => a.path.localeCompare(b.path));
	});

	let deleteDialogOpen = $state(false);
	let renamingSkillId = $state<string | null>(null);

	return {
		get skills() {
			return skills;
		},
		get selectedSkillId() {
			return selectedSkillId;
		},
		get selectedSkill() {
			return selectedSkill;
		},
		get selectedReferences() {
			return selectedReferences;
		},
		get deleteDialogOpen() {
			return deleteDialogOpen;
		},
		get renamingSkillId() {
			return renamingSkillId;
		},

		selectSkill(id: string) {
			selectedSkillId = id;
		},

		createSkill(name: string) {
			const id = generateId();
			workspace.tables.skills.set({
				id,
				name,
				description: 'TODO—describe when and why to use this skill.',
				license: undefined,
				compatibility: undefined,
				metadata: undefined,
				allowedTools: undefined,
				updatedAt: Date.now(),
				_v: 1,
			});
			selectedSkillId = id;
			return id;
		},

		updateSkill(
			id: string,
			updates: Partial<
				Pick<Skill, 'name' | 'description' | 'license' | 'compatibility'>
			>,
		) {
			workspace.tables.skills.update(id, { ...updates, updatedAt: Date.now() });
		},

		deleteSkill(id: string) {
			// Cascade: delete all references for this skill
			for (const ref of referencesMap.values()) {
				if (ref.skillId === id) workspace.tables.references.delete(ref.id);
			}
			workspace.tables.skills.delete(id);
			if (selectedSkillId === id) selectedSkillId = null;
			deleteDialogOpen = false;
		},

		openDelete() {
			deleteDialogOpen = true;
		},
		closeDelete() {
			deleteDialogOpen = false;
		},

		startRename(id: string) {
			renamingSkillId = id;
		},
		cancelRename() {
			renamingSkillId = null;
		},
		confirmRename(newName: string) {
			if (!renamingSkillId || !newName.trim()) {
				renamingSkillId = null;
				return;
			}
			workspace.tables.skills.update(renamingSkillId, {
				name: newName.trim(),
				updatedAt: Date.now(),
			});
			renamingSkillId = null;
		},

		createReference(skillId: string, path: string) {
			const id = generateId();
			workspace.tables.references.set({
				id,
				skillId,
				path,
				updatedAt: Date.now(),
				_v: 1,
			});
			return id;
		},

		deleteReference(id: string) {
			workspace.tables.references.delete(id);
		},
	};
}

export const skillsState = createSkillsState();
