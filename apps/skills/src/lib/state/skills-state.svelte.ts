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
 * </script>
 *
 * {#each skillsState.skills as skill (skill.id)}
 *   <p>{skill.name}</p>
 * {/each}
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

	const selected = $derived.by(() => {
		if (!selectedSkillId) return { skill: null, references: [] };
		const skill = skillsMap.get(selectedSkillId) ?? null;
		const references = referencesMap
			.values()
			.toArray()
			.filter((r) => r.skillId === selectedSkillId)
			.sort((a, b) => a.path.localeCompare(b.path));
		return { skill, references };
	});


	return {
		get skills() {
			return skills;
		},
		get selectedSkillId() {
			return selectedSkillId;
		},
		set selectedSkillId(id: string | null) {
			selectedSkillId = id;
		},
		get selectedSkill() {
			return selected.skill;
		},
		get selectedReferences() {
			return selected.references;
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
