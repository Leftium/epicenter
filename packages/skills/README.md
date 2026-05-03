# @epicenter/skills

`@epicenter/skills` defines the shared skills data model: table schemas, row
types, the pure skills workspace factory, per-row document builders, guid
helpers, and read action factories. It does not own browser storage. Browser
apps compose IndexedDB, BroadcastChannel, and `createBrowserDocumentFamily` at
the app boundary.

## Root Export

```typescript
import {
	SKILLS_WORKSPACE_ID,
	createReferenceContentDoc,
	createSkillInstructionsDoc,
	createSkillsActions,
	openSkills,
	referenceContentDocGuid,
	referencesTable,
	skillInstructionsDocGuid,
	skillsTable,
} from '@epicenter/skills';
```

The root export is intentionally runtime-neutral. It is safe to use from
browser apps, Node scripts, and package-level tests because it does not import
IndexedDB or file-system APIs.

`openSkills()` builds the shared encrypted Y.Doc, tables, KV, and batch helper.
It does not create instruction or reference document families, because those
families own runtime persistence and browser cleanup.

## Browser Composition

Browser callers layer browser lifecycle wiring on top of `openSkills()`:

```typescript
const doc = openSkills();
const idb = attachIndexedDb(doc.ydoc);
attachBroadcastChannel(doc.ydoc);

const instructionsDocs = createBrowserDocumentFamily({
	ids() {
		return doc.tables.skills.getAllValid().map((skill) => skill.id);
	},
	create(skillId: string) {
		const instructionsDoc = createSkillInstructionsDoc({
			skillId,
			workspaceId: doc.ydoc.guid,
			skillsTable: doc.tables.skills,
			attachPersistence: attachIndexedDb,
		});

		return {
			...instructionsDoc,
			persistence: instructionsDoc.persistence as ReturnType<
				typeof attachIndexedDb
			>,
			sync: null,
		};
	},
	clearLocalData(skillId: string) {
		return clearDocument(
			skillInstructionsDocGuid({
				workspaceId: doc.ydoc.guid,
				skillId,
			}),
		);
	},
});
```

That inline family source is deliberate. The single source of truth is
`openSkills()`, `createSkillInstructionsDoc()`, and `skillInstructionsDocGuid()`,
not a browser wrapper inside the shared package.

## Node Composition

Use `@epicenter/skills/node` when disk import/export actions are needed:

```typescript
import { openSkillsNodeWorkspace } from '@epicenter/skills/node';

using workspace = openSkillsNodeWorkspace({ workspaceId: 'epicenter.skills' });
await workspace.actions.importFromDisk({ dir: '.agents/skills' });
await workspace.actions.exportToDisk({ dir: '.agents/skills' });
```

Node opens instruction and reference docs per operation. The browser family
exists for shared live identity, active child sync fanout, and IndexedDB reset;
the Node import/export path does not need those lifecycle rules.

## Data Model

```text
skills row
  metadata columns
  instructions document

references row
  skillId
  content document
```

The catalog stays small and queryable. Markdown bodies live in per-row Y.Docs
so editors can load and collaborate on them on demand.

## License

MIT
