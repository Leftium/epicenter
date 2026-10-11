import { InstantString } from '@epicenter/app/field';
import type { Skill, SkillsData } from '@epicenter/skills';

export type SkillMetadataUpdate = Partial<
	Pick<Skill, 'name' | 'description' | 'license' | 'compatibility'>
>;

/**
 * Skills' rows, read straight out of the store.
 *
 * The runtime supplies reactive native reads; selection belongs to this
 * module. There are no copied rows or subscriptions to refresh and dispose.
 */
export function createSkillsState({ data }: { data: SkillsData }) {
	let selectedSkillId = $state<string | null>(null);
	const nonconforming = $derived([
		...data.tables.skills.nonconforming,
		...data.tables.skillReferences.nonconforming,
	]);

	function readSkillsByName() {
		return data.tables.skills
			.rows
			.toSorted((left, right) => left.name.localeCompare(right.name));
	}
	const sortedSkills = $derived(readSkillsByName());
	const selectedSkill = $derived(
		selectedSkillId ? (data.tables.skills.get(selectedSkillId) ?? null) : null,
	);
	const selectedReferences = $derived(
		selectedSkillId
			? data.tables.skillReferences
					.rows
					.filter((reference) => reference.skillId === selectedSkillId)
					.toSorted((left, right) => left.path.localeCompare(right.path))
			: [],
	);

	return {
		get skills() {
			return sortedSkills;
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
		get nonconforming() {
			return nonconforming;
		},
		selectSkill(id: string | null) {
			selectedSkillId = id;
		},

		/** Apply a change, or throw so the caller's toast can present it. */
		createSkill(name: string): string {
			const skill = data.tables.skills.create({
				sourceId: crypto.randomUUID(),
				name,
				description: 'TODO: describe when and why to use this skill.',
				license: null,
				compatibility: null,
				metadata: null,
				allowedTools: null,
				updatedAt: InstantString.now(),
			});
			selectedSkillId = skill.id;
			return skill.id;
		},

		updateSkill(id: string, updates: SkillMetadataUpdate): void {
			const { error } = data.tables.skills.update(id, {
				...updates,
				updatedAt: InstantString.now(),
			});
			if (error !== null) throw error;
		},

		deleteSkill(id: string): void {
			for (const reference of data.tables.skillReferences.rows) {
				if (reference.skillId !== id) continue;
				data.tables.skillReferences.delete(reference.id);
			}
			data.tables.skills.delete(id);
			if (selectedSkillId === id) {
				selectedSkillId = readSkillsByName()[0]?.id ?? null;
			}
		},

		createReference(skillId: string, path: string): string {
			const reference = data.tables.skillReferences.create({
				skillId,
				path,
				updatedAt: InstantString.now(),
			});
			return reference.id;
		},

		deleteReference(id: string): void {
			data.tables.skillReferences.delete(id);
		},
	};
}
