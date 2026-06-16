/**
 * Inlined fixtures for the `/demo/references` route: a three-table content vault
 * (pages -> adaptations -> publications) that exercises the row-level reference validator.
 *
 * Mirrors `examples/matter/content-vault/` so the route is self-contained (the example vault
 * lives outside the app root). Two references are DELIBERATELY dangling — `orphan-adaptation`
 * points at a missing page, `stale-pub` at a missing adaptation — so the UI has resolved AND
 * unresolved relations to render, and the validator has something to report.
 */

/** One table's worth of fixtures: its name, its `matter.json` text, and its rows. */
export type FixtureFolder = {
	table: string;
	modelText: string;
	rows: { fileName: string; content: string }[];
};

const pages: FixtureFolder = {
	table: 'pages',
	modelText: JSON.stringify({
		fields: {
			title: { type: 'string', minLength: 1 },
			status: { type: 'string', enum: ['captured', 'refined'] },
		},
		optional: ['status'],
	}),
	rows: [
		{
			fileName: 'become-the-source.md',
			content: '---\ntitle: Become the Source\nstatus: refined\n---\nThe canonical idea.',
		},
		{
			fileName: 'how-we-plan-ourselves.md',
			content:
				'---\ntitle: How We Plan Ourselves\nstatus: refined\n---\nA second source page.',
		},
	],
};

const adaptations: FixtureFolder = {
	table: 'adaptations',
	modelText: JSON.stringify({
		fields: {
			title: { type: 'string', minLength: 1 },
			page: { type: 'string', 'x-ref': 'pages' },
			format: {
				type: 'string',
				enum: ['thread', 'carousel', 'short-video', 'article'],
			},
		},
	}),
	rows: [
		{
			fileName: 'become-the-source-thread.md',
			content:
				'---\ntitle: Become the Source (thread)\npage: become-the-source\nformat: thread\n---\nA thread.',
		},
		{
			fileName: 'become-the-source-carousel.md',
			content:
				'---\ntitle: Become the Source (carousel)\npage: become-the-source\nformat: carousel\n---\nMany-to-one.',
		},
		{
			fileName: 'plan-yourself-short.md',
			content:
				'---\ntitle: Plan Yourself (short video)\npage: how-we-plan-ourselves\nformat: short-video\n---\nOther page.',
		},
		{
			fileName: 'orphan-adaptation.md',
			content:
				'---\ntitle: Orphan Adaptation\npage: ghost-page\nformat: article\n---\nDangling: no pages/ghost-page.md.',
		},
	],
};

const publications: FixtureFolder = {
	table: 'publications',
	modelText: JSON.stringify({
		fields: {
			adaptation: { type: 'string', 'x-ref': 'adaptations' },
			platform: { type: 'string', enum: ['x', 'tiktok', 'reels', 'shorts', 'linkedin'] },
			url: { type: 'string', format: 'uri' },
		},
		optional: ['url'],
	}),
	rows: [
		{
			fileName: 'become-the-source-thread-x.md',
			content:
				'---\nadaptation: become-the-source-thread\nplatform: x\nurl: https://x.com/example/status/1\n---\nShipped.',
		},
		{
			fileName: 'plan-yourself-short-tiktok.md',
			content:
				'---\nadaptation: plan-yourself-short\nplatform: tiktok\nurl: https://tiktok.com/@example/video/2\n---\nShipped.',
		},
		{
			fileName: 'stale-pub.md',
			content:
				'---\nadaptation: deleted-adaptation\nplatform: reels\n---\nDangling: adaptation renamed or deleted.',
		},
	],
};

/** The fixtures in dependency order (a table appears before the tables that point at it). */
export const REFERENCE_FIXTURES: FixtureFolder[] = [pages, adaptations, publications];
