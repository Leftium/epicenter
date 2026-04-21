# Epicenter Workspace API

## Clean, Direct API

The epicenter workspace system provides a clean API where actions are directly callable functions:

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineMutation,
	defineQuery,
	defineTable,
	generateId,
} from '@epicenter/workspace';

const todosTable = defineTable(
	type({ id: 'string', title: 'string', completed: 'boolean', _v: '1' }),
);

const todosDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { todos: todosTable });

	const actions = {
		getTodos: defineQuery({
			handler: () => tables.todos.getAllValid(),
		}),

		createTodo: defineMutation({
			input: type({ title: 'string>0' }),
			handler: ({ title }) => {
				const newTodo = { id: generateId(), title, completed: false, _v: 1 as const };
				tables.todos.set(newTodo);
				return newTodo;
			},
		}),
	};

	return {
		id,
		ydoc,
		tables,
		actions,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const todos = todosDoc.open('todos');

// Actions are directly callable — no .execute() needed!
todos.actions.createTodo({ title: 'Learn Epicenter' });
const allTodos = todos.actions.getTodos();

// Actions still have properties for introspection
console.log(todos.actions.createTodo.type); // 'mutation'
console.log(todos.actions.getTodos.type);   // 'query'
```

## Key Features

1. **Direct action calls**: `todos.createTodo()` not `todos.createTodo.execute()`
2. **Automatic validation**: Input schemas are validated using Standard Schema
3. **Full type safety**: Input types are inferred from schemas
4. **Simple workspace return**: `runWorkspace` returns the workspace instance directly
5. **Action introspection**: Access `type`, `input`, and `handler` properties when needed

## Input Validation with Standard Schema

Actions use the [Standard Schema](https://github.com/standard-schema/standard-schema) specification, making them compatible with popular validation libraries:

- **ArkType** (recommended): `type({ name: 'string' })`
- **Valibot**: `v.object({ name: v.string() })`
- **Zod**: `z.object({ name: z.string() })`
- **Effect Schema**: `S.struct({ name: S.string })`
- Any other Standard Schema compliant library

## Action Types

### Queries

For read operations that don't modify state:

```typescript
defineQuery({
	input: type({ id: 'string' }),
	handler: async (input) => {
		// input.id is typed as string
		return findById(input.id);
	},
});
```

### Mutations

For operations that modify state:

```typescript
defineMutation({
	input: type({
		title: 'string',
		completed: 'boolean',
	}),
	handler: async (input) => {
		// input is fully typed
		return createItem(input);
	},
});
```
