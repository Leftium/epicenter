<script lang="ts">
	import { CommandPalette, type CommandPaletteItem } from '@epicenter/ui/command-palette';
	import { skillsState } from '$lib/state/skills-state.svelte';

	let open = $state(false);
	let searchQuery = $state('');
	let debouncedQuery = $state('');

	// Debounce search input at 150ms
	$effect(() => {
		const query = searchQuery;
		const timer = setTimeout(() => {
			debouncedQuery = query;
		}, 150);
		return () => clearTimeout(timer);
	});

	// Reset search when palette closes
	$effect(() => {
		if (!open) {
			searchQuery = '';
			debouncedQuery = '';
		}
	});

	// Filtered results: startsWith first, then includes, cap 50
	const filteredSkills = $derived.by(() => {
		const q = debouncedQuery.toLowerCase().trim();
		const skills = skillsState.skills;
		if (!q) return skills.slice(0, 50);

		const startsWith: typeof skills = [];
		const includes: typeof skills = [];

		for (const skill of skills) {
			const name = skill.name.toLowerCase();
			if (name.startsWith(q)) {
				startsWith.push(skill);
			} else if (name.includes(q) || skill.description.toLowerCase().includes(q)) {
				includes.push(skill);
			}
			if (startsWith.length + includes.length >= 50) break;
		}

		return [...startsWith, ...includes].slice(0, 50);
	});

	const skillItems = $derived<CommandPaletteItem[]>(
		filteredSkills.map((skill) => ({
			id: skill.id,
			label: skill.name,
			description: skill.description,
			group: 'Skills',
			onSelect: () => {
				skillsState.selectSkill(skill.id);
			},
		})),
	);
</script>

<svelte:window
	onkeydown={(e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			open = !open;
		}
	}}
/>

<CommandPalette
	items={skillItems}
	bind:open
	bind:value={searchQuery}
	shouldFilter={false}
	placeholder="Search skills..."
	emptyMessage="No skills found."
	title="Search Skills"
	description="Search for a skill by name or description"
/>
