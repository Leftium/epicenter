import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	boolean,
	date,
	id,
	integer,
	select,
	setting,
	table,
	text,
} from '../schema';
import { createDefinition } from './definition-helper';

describe('createDefinition', () => {
	describe('definition.toJSON()', () => {
		test('returns empty definition when nothing is set', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			const result = definition.toJSON();
			// Empty Y.Map returns {} - tables and kv are undefined
			expect(result.tables).toBeUndefined();
			expect(result.kv).toBeUndefined();
		});

		test('returns full definition snapshot', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					icon: '📝',
					description: 'Blog posts',
					fields: [id(), text('title')] as const,
				}),
			);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);

			const result = definition.toJSON();
			expect(result.tables).toBeDefined();
			expect(result.tables!.posts).toBeDefined();
			expect(result.tables!.posts!.name).toBe('Posts');
			expect(result.kv).toBeDefined();
			expect(result.kv!.theme).toBeDefined();
		});
	});

	describe('definition.tables', () => {
		test('tables.get() returns undefined for non-existent table', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			expect(definition.tables.get('nonexistent')).toBeUndefined();
		});

		test('tables.get() returns helper for existing table', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					icon: '📝',
					description: 'Blog posts',
					fields: [id(), text('title')] as const,
				}),
			);

			const posts = definition.tables.get('posts');
			expect(posts).toBeDefined();
			expect(posts!.toJSON().name).toBe('Posts');
		});

		test('tables.get().toJSON() returns snapshot without helper', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					icon: '📝',
					description: 'Blog posts',
					fields: [id(), text('title')] as const,
				}),
			);

			const snapshot = definition.tables.get('posts')?.toJSON();
			expect(snapshot).toBeDefined();
			expect(snapshot!.name).toBe('Posts');
			expect(snapshot!.fields.find((f) => f.id === 'id')!.type).toBe('id');
		});

		test('tables.has() checks existence', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			expect(definition.tables.has('posts')).toBe(false);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);

			expect(definition.tables.has('posts')).toBe(true);
		});

		test('tables.set() creates a new table definition', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					icon: '📝',
					description: 'Blog posts',
					fields: [id(), text('title')] as const,
				}),
			);

			expect(definition.tables.get('posts')).toBeDefined();
			const posts = definition.tables.get('posts')!.toJSON();
			expect(posts.name).toBe('Posts');
			expect(posts.fields.find((f) => f.id === 'id')!.type).toBe('id');
			expect(posts.fields.find((f) => f.id === 'title')!.type).toBe('text');
		});

		test('tables.toJSON() returns all table definitions', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id(), text('title')] as const }),
			);
			definition.tables.set(
				'users',
				table('users', { name: 'Users', fields: [id(), text('name')] as const }),
			);

			const all = definition.tables.toJSON();
			expect(Object.keys(all)).toHaveLength(2);
			expect(all.posts!.name).toBe('Posts');
			expect(all.users!.name).toBe('Users');
		});

		test('tables.entries() returns [name, definition] pairs', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);
			definition.tables.set(
				'users',
				table('users', { name: 'Users', fields: [id()] as const }),
			);

			const entries = definition.tables.entries();
			expect(entries).toHaveLength(2);
			expect(entries.map(([name]) => name).sort()).toEqual(['posts', 'users']);
		});

		test('tables.get().delete() removes a table definition', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id(), text('title')] as const }),
			);

			expect(definition.tables.get('posts')).toBeDefined();
			const deleted = definition.tables.get('posts')!.delete();
			expect(deleted).toBe(true);
			expect(definition.tables.get('posts')).toBeUndefined();
		});

		test('tables.keys() returns all table names', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);
			definition.tables.set(
				'users',
				table('users', { name: 'Users', fields: [id()] as const }),
			);

			const keys = definition.tables.keys();
			expect(keys).toContain('posts');
			expect(keys).toContain('users');
		});
	});

	describe('definition.tables.get().fields', () => {
		test('fields.get() returns undefined for non-existent field', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);

			expect(
				definition.tables.get('posts')!.fields.get('nonexistent'),
			).toBeUndefined();
		});

		test('fields.get() returns schema for existing field', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id(), text('title')] as const }),
			);

			const titleSchema = definition.tables.get('posts')!.fields.get('title');
			expect(titleSchema).toBeDefined();
			expect(titleSchema!.type).toBe('text');
		});

		test('fields.has() checks field existence', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id(), text('title')] as const }),
			);

			expect(definition.tables.get('posts')!.fields.has('title')).toBe(true);
			expect(definition.tables.get('posts')!.fields.has('nonexistent')).toBe(
				false,
			);
		});

		test('fields.set() adds a field to the table', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id(), text('title')] as const }),
			);

			definition.tables
				.get('posts')!
				.fields.set('dueDate', date('dueDate', { nullable: true }));

			const field = definition.tables.get('posts')!.fields.get('dueDate');
			expect(field).toBeDefined();
			expect(field!.type).toBe('date');
		});

		test('fields.delete() removes a field from the table', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					fields: [id(), text('title'), boolean('extra')] as const,
				}),
			);

			expect(definition.tables.get('posts')!.fields.has('extra')).toBe(true);

			const deleted = definition.tables.get('posts')!.fields.delete('extra');
			expect(deleted).toBe(true);
			expect(definition.tables.get('posts')!.fields.has('extra')).toBe(false);
		});

		test('fields.toJSON() returns all fields', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					fields: [id(), text('title'), integer('count')] as const,
				}),
			);

			const fields = definition.tables.get('posts')!.fields.toJSON();
			expect(Object.keys(fields)).toHaveLength(3);
			expect(fields.id!.type).toBe('id');
			expect(fields.title!.type).toBe('text');
			expect(fields.count!.type).toBe('integer');
		});

		test('fields.keys() returns all field names', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id(), text('title')] as const }),
			);

			const keys = definition.tables.get('posts')!.fields.keys();
			expect(keys).toContain('id');
			expect(keys).toContain('title');
		});

		test('fields.entries() returns [name, schema] pairs', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id(), text('title')] as const }),
			);

			const entries = definition.tables.get('posts')!.fields.entries();
			expect(entries).toHaveLength(2);
			expect(entries.map(([name]) => name).sort()).toEqual(['id', 'title']);
		});
	});

	describe('definition.tables.get() property getters and setters', () => {
		test('property getters return table metadata', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					icon: '📝',
					description: 'Blog posts',
					fields: [id()] as const,
				}),
			);

			const posts = definition.tables.get('posts')!;
			expect(posts.name).toBe('Posts');
			expect(posts.icon).toBe('emoji:📝');
			expect(posts.description).toBe('Blog posts');
		});

		test('setName() updates table name', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					icon: '📝',
					description: 'Blog posts',
					fields: [id()] as const,
				}),
			);

			const posts = definition.tables.get('posts')!;
			posts.setName('Blog Posts');

			expect(posts.name).toBe('Blog Posts');
			expect(posts.icon).toBe('emoji:📝'); // unchanged
		});

		test('setIcon() updates table icon', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					icon: '📝',
					description: 'Blog posts',
					fields: [id()] as const,
				}),
			);

			const posts = definition.tables.get('posts')!;
			posts.setIcon('emoji:✍️');

			expect(posts.icon).toBe('emoji:✍️');
			expect(posts.name).toBe('Posts'); // unchanged
		});

		test('setDescription() updates table description', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', {
					name: 'Posts',
					description: 'Blog posts',
					fields: [id()] as const,
				}),
			);

			const posts = definition.tables.get('posts')!;
			posts.setDescription('All my blog posts');

			expect(posts.description).toBe('All my blog posts');
		});
	});

	describe('definition.kv', () => {
		test('kv.get() returns undefined for non-existent key', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			expect(definition.kv.get('nonexistent')).toBeUndefined();
		});

		test('kv.get() returns helper for existing key', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);

			const theme = definition.kv.get('theme');
			expect(theme).toBeDefined();
			expect(theme!.toJSON().name).toBe('Theme');
		});

		test('kv.get().toJSON() returns snapshot without helper', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);

			const snapshot = definition.kv.get('theme')?.toJSON();
			expect(snapshot).toBeDefined();
			expect(snapshot!.name).toBe('Theme');
			expect(snapshot!.field.type).toBe('select');
		});

		test('kv.has() checks existence', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			expect(definition.kv.has('theme')).toBe(false);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);

			expect(definition.kv.has('theme')).toBe(true);
		});

		test('kv.set() creates a new KV definition', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					icon: 'emoji:🎨',
					description: 'Color theme',
					field: select('theme', {
						options: ['light', 'dark'] as const,
						default: 'light',
					}),
				}),
			);

			expect(definition.kv.get('theme')).toBeDefined();
			const theme = definition.kv.get('theme')!.toJSON();
			expect(theme.name).toBe('Theme');
			expect(theme.field.type).toBe('select');
		});

		test('kv.toJSON() returns all KV definitions', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);
			definition.kv.set(
				'count',
				setting({ name: 'Count', field: integer('count', { default: 0 }) }),
			);

			const all = definition.kv.toJSON();
			expect(Object.keys(all)).toHaveLength(2);
			expect(all.theme!.field.type).toBe('select');
			expect(all.count!.field.type).toBe('integer');
		});

		test('kv.entries() returns [name, definition] pairs', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);
			definition.kv.set(
				'count',
				setting({ name: 'Count', field: integer('count', { default: 0 }) }),
			);

			const entries = definition.kv.entries();
			expect(entries).toHaveLength(2);
			expect(entries.map(([name]) => name).sort()).toEqual(['count', 'theme']);
		});

		test('kv.get().delete() removes a KV definition', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);

			expect(definition.kv.get('theme')).toBeDefined();
			const deleted = definition.kv.get('theme')!.delete();
			expect(deleted).toBe(true);
			expect(definition.kv.get('theme')).toBeUndefined();
		});
	});

	describe('definition.kv.get() property getters and setters', () => {
		test('property getters return KV metadata', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					icon: 'emoji:🎨',
					description: 'Color theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);

			const theme = definition.kv.get('theme')!;
			expect(theme.name).toBe('Theme');
			expect(theme.icon).toBe('emoji:🎨');
			expect(theme.description).toBe('Color theme');
			expect(theme.field.type).toBe('select');
		});

		test('setName() updates KV name', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);

			const theme = definition.kv.get('theme')!;
			theme.setName('Color Theme');

			expect(theme.name).toBe('Color Theme');
		});

		test('setField() updates KV field schema', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.kv.set(
				'theme',
				setting({
					name: 'Theme',
					field: select('theme', { options: ['light', 'dark'] as const }),
				}),
			);

			const theme = definition.kv.get('theme')!;
			theme.setField(
				select('theme', { options: ['light', 'dark', 'auto'] as const }),
			);

			expect(theme.field!.type).toBe('select');
			expect(
				(theme.field as unknown as { options: string[] }).options,
			).toContain('auto');
		});
	});

	describe('definition.merge()', () => {
		test('merges tables and kv definitions', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.merge({
				tables: {
					posts: table('posts', {
						name: 'Posts',
						fields: [id(), text('title')] as const,
					}),
					users: table('users', {
						name: 'Users',
						fields: [id(), text('name')] as const,
					}),
				},
				kv: {
					theme: setting({
						name: 'Theme',
						field: select('theme', { options: ['light', 'dark'] as const }),
					}),
				},
			});

			expect(definition.tables.get('posts')).toBeDefined();
			expect(definition.tables.get('users')).toBeDefined();
			expect(definition.kv.get('theme')).toBeDefined();
		});
	});

	describe('observation', () => {
		test('definition.observe() fires on any change', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			let callCount = 0;
			const unsub = definition.observe(() => {
				callCount++;
			});

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);
			expect(callCount).toBeGreaterThan(0);

			unsub();
		});

		test('definition.tables.observe() fires on table add/delete', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			const allChanges: Map<string, 'add' | 'delete'>[] = [];
			const unsub = definition.tables.observe((changes) => {
				allChanges.push(changes);
			});

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);
			expect(allChanges.length).toBeGreaterThan(0);
			expect(allChanges.some((m) => m.get('posts') === 'add')).toBe(true);

			unsub();
		});

		test('fields.observe() fires on field add/update/delete', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);

			const allChanges: Map<string, 'add' | 'update' | 'delete'>[] = [];
			const unsub = definition.tables
				.get('posts')!
				.fields.observe((changes) => {
					allChanges.push(changes);
				});

			definition.tables.get('posts')!.fields.set('title', text('title'));
			expect(allChanges.length).toBeGreaterThan(0);
			expect(allChanges.some((m) => m.get('title') === 'add')).toBe(true);

			unsub();
		});
	});

	describe('existence checks', () => {
		test('check table exists by calling tables.get() or tables.has()', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			// Doesn't exist
			expect(definition.tables.get('posts')).toBeUndefined();
			expect(definition.tables.has('posts')).toBe(false);

			// Create it
			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);

			// Now exists
			expect(definition.tables.get('posts')).toBeDefined();
			expect(definition.tables.has('posts')).toBe(true);
		});

		test('check field exists by calling fields.has()', () => {
			const ydoc = new Y.Doc();
			const definitionMap = ydoc.getMap('definition');
			const definition = createDefinition(definitionMap);

			definition.tables.set(
				'posts',
				table('posts', { name: 'Posts', fields: [id()] as const }),
			);

			// Doesn't exist
			expect(definition.tables.get('posts')!.fields.has('title')).toBe(false);

			// Create it
			definition.tables.get('posts')!.fields.set('title', text('title'));

			// Now exists
			expect(definition.tables.get('posts')!.fields.has('title')).toBe(true);
		});
	});
});
