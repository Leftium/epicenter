/**
 * Coverage for the `/list` manifest projection.
 *
 * `/list` is now a one-primitive route: describe every hosted route and
 * prefix each action key with the route name.
 */

import { describe, expect, test } from 'bun:test';
import { defineQuery } from '../shared/actions.js';
import { createRouteActionManifest } from './app.js';

describe('/list route', () => {
	test('returns route-prefixed paths under the action root', () => {
		const manifest = createRouteActionManifest([
			{
				route: 'demo',
				actions: {
					counter_get: defineQuery({
						description: 'Read the counter',
						handler: () => 0,
					}),
				},
			},
		]);

		expect(Object.keys(manifest).sort()).toEqual(['demo.counter_get']);
		expect(manifest['demo.counter_get']?.description).toBe('Read the counter');
	});

	test('returns an empty manifest when the collaboration has no actions', () => {
		const manifest = createRouteActionManifest([{ route: 'demo', actions: {} }]);

		expect(manifest).toEqual({});
	});

	test('prefixes actions from every daemon route', () => {
		const manifest = createRouteActionManifest([
			{
				route: 'notes',
				actions: {
					notes_add: defineQuery({ handler: () => null }),
				},
			},
			{
				route: 'tasks',
				actions: {
					tasks_list: defineQuery({ handler: () => [] }),
				},
			},
		]);

		expect(Object.keys(manifest).sort()).toEqual([
			'notes.notes_add',
			'tasks.tasks_list',
		]);
	});
});
