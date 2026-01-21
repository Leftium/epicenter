# Spec: Script Transformation Type for Whispering

**Date:** 2026-01-21
**Status:** Draft
**Author:** AI Assistant

## Overview

Add a new transformation step type `script` that allows users to transform transcribed text by running it through a custom JavaScript function. The script executes in a sandboxed environment for security. TypeScript syntax is supported (types are stripped before execution).

## Problem Statement

Current transformation types are either:

- **find_replace**: Simple but limited to pattern matching
- **prompt_transform**: Powerful but requires API keys, incurs costs, and adds latency

Users need a middle ground: programmable transformations that are:

- Free (no API calls)
- Fast (local execution)
- Flexible (full control over logic)
- Safe (sandboxed execution)

## Real-World Use Cases (from GitHub Issues)

### 1. Personal Dictionary for Transcription Correction ([#904](https://github.com/EpicenterHQ/epicenter/issues/904))

Users want to automatically correct consistently mistranscribed words (names, technical terms, brand names).

**Script solution:**

```javascript
// Personal dictionary - correct common mistranscriptions
const dictionary = {
	'john leftie um': 'John Leftium',
	'epicenter hq': 'EpicenterHQ',
	whisperring: 'Whispering',
	'type script': 'TypeScript',
	'java script': 'JavaScript',
};

let result = input;
for (const [wrong, correct] of Object.entries(dictionary)) {
	result = result.replace(new RegExp(wrong, 'gi'), correct);
}
return result;
```

### 2. Fix Double Spaces in Regex Transform ([#962](https://github.com/EpicenterHQ/epicenter/issues/962))

The current regex find_replace can introduce double spaces. A script can handle this more intelligently.

**Script solution:**

```javascript
// Remove filler words without leaving double spaces
return input
	.replace(/\b(um|uh|like|you know)\b/gi, '')
	.replace(/\s+/g, ' ') // Collapse multiple spaces
	.trim();
```

### 3. Multi-line Find/Replace Patterns ([#988](https://github.com/EpicenterHQ/epicenter/issues/988))

Users want to use newline characters in find/replace, but the current Input component doesn't support it.

**Script solution:**

```javascript
// Replace patterns that span multiple lines
return input
	.replace(/Dear Sir\/Madam,\n\n/g, 'Hi,\n\n')
	.replace(/\n\nBest regards,\n/g, '\n\nThanks,\n');
```

### 4. Punctuation Commands ([#1253](https://github.com/EpicenterHQ/epicenter/issues/1253))

Users want to dictate punctuation by saying words like "comma" or "period" and have them converted to symbols.

**Script solution:**

```javascript
// Convert spoken punctuation to symbols
const punctuation = {
	' comma': ',',
	' period': '.',
	' question mark': '?',
	' exclamation point': '!',
	' colon': ':',
	' semicolon': ';',
	' open paren': ' (',
	' close paren': ')',
	' open bracket': ' [',
	' close bracket': ']',
	' open quote': ' "',
	' close quote': '"',
	' new line': '\n',
	' new paragraph': '\n\n',
};

let result = input;
for (const [word, symbol] of Object.entries(punctuation)) {
	result = result.replace(new RegExp(word, 'gi'), symbol);
}
return result;
```

### 5. Combining Multiple Transform Concerns ([#1205](https://github.com/EpicenterHQ/epicenter/issues/1205), [#1208](https://github.com/EpicenterHQ/epicenter/issues/1208))

Users want to apply multiple transformations (filler word removal + personal dictionary + punctuation commands) but currently can only enable one transformation at a time.

**Script solution:** A single script step can combine all these concerns with controlled ordering:

```javascript
// Combined transformation: punctuation -> dictionary -> cleanup
// Order matters! Process punctuation commands before dictionary replacements

let result = input;

// 1. Punctuation commands (must come first)
const punctuation = {
	' comma': ',',
	' period': '.',
	' question mark': '?',
};
for (const [word, symbol] of Object.entries(punctuation)) {
	result = result.replace(new RegExp(word, 'gi'), symbol);
}

// 2. Personal dictionary
const dictionary = {
	'john leftie um': 'John Leftium',
	'type script': 'TypeScript',
};
for (const [wrong, correct] of Object.entries(dictionary)) {
	result = result.replace(new RegExp(wrong, 'gi'), correct);
}

// 3. Cleanup (filler words + normalize spaces)
result = result
	.replace(/\b(um|uh|like|you know)\b/gi, '')
	.replace(/\s+/g, ' ')
	.trim();

return result;
```

This addresses the core need from #1205 and #1208 - combining multiple transform concerns in a single step with explicit ordering control.

### 6. Additional Use Cases

**Complex text normalization:**

```javascript
// Standardize dates, numbers, and formatting
return input
	.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g, '$3-$1-$2') // MM/DD/YYYY -> YYYY-MM-DD
	.replace(/\$(\d+)k/gi, (_, n) => `$${n},000`) // $5k -> $5,000
	.replace(/(\d+)%/g, '$1 percent'); // 50% -> 50 percent
```

**Template wrapping:**

```javascript
// Wrap transcription in a meeting notes template
return `## Meeting Notes - ${new Date().toLocaleDateString()}

### Transcript
${input}

### Action Items
- [ ] 

### Next Steps
- 
`;
```

## Design Decisions

### Decision 1: TypeScript Support

**Choice:** Strip types, run as JavaScript

TypeScript types are stripped at execution time using the `typescript` package's `transpileModule()`. This allows users to write typed code (or paste from their editor) while keeping the sandbox simple.

```typescript
// User writes:
const dictionary: Record<string, string> = { foo: 'bar' };
return input.replace(/foo/g, dictionary['foo'] as string);

// Executed as:
const dictionary = { foo: 'bar' };
return input.replace(/foo/g, dictionary['foo']);
```

### Decision 2: No Async/Await

**Choice:** Synchronous execution only

Reasons:

- Sandbox doesn't expose network APIs anyway
- No file system access
- Simpler execution model
- Easier timeout handling
- All string operations are synchronous

If a future use case requires async (e.g., calling a user-provided local API), we can revisit.

### Decision 3: Minimal Helper Library

**Choice:** Provide `input` variable only; no helper library for MVP

Reasons:

- JavaScript's built-in string methods are comprehensive
- Users can define their own helpers within the script
- Avoids API surface maintenance burden
- Examples in documentation can serve as copy-paste helpers

**Available to scripts:**

- `input` - the text to transform (string)
- All standard JavaScript built-ins that QuickJS supports
- `JSON.parse()`, `JSON.stringify()`
- `parseInt()`, `parseFloat()`, `isNaN()`, `isFinite()`
- All `String.prototype` methods
- `RegExp`
- `Array`, `Object`, `Math`, `Date`

**NOT available:**

- `fetch`, `XMLHttpRequest` (no network)
- `setTimeout`, `setInterval` (no async)
- `eval`, `Function` constructor (no code generation)
- `require`, `import` (no modules)
- DOM APIs, `window`, `document`
- `console.log` (maybe later for debugging)

### Decision 4: Textarea UI for MVP

**Choice:** Simple `<Textarea>` instead of code editor

Reasons:

- Transformation dialog already crowded
- Primary use case: paste code from external editor or AI
- Avoids CodeMirror/Monaco bundle size (~200KB-2MB)
- Can upgrade to code editor later if users request

## Schema Changes

**File:** `apps/whispering/src/lib/constants/database/transformation-types.ts`

```typescript
export const TRANSFORMATION_STEP_TYPES = [
	'prompt_transform',
	'find_replace',
	'script', // NEW
] as const;

export const TRANSFORMATION_STEP_TYPES_TO_LABEL = {
	prompt_transform: 'Prompt Transform',
	find_replace: 'Find Replace',
	script: 'Script', // NEW
} as const;
```

**File:** `apps/whispering/src/lib/services/isomorphic/db/models/transformation-steps.ts`

Add to V3 schema:

```typescript
// Script transformation fields
'script.code': 'string',  // The JavaScript code (TS types stripped at runtime)
```

Note: No `script.language` field needed since we always strip types.

## Sandbox Implementation

### Package: `quickjs-emscripten` (~150KB gzipped)

**Why QuickJS:**

1. True process isolation via WebAssembly
2. No access to DOM, fetch, or browser APIs by default
3. Configurable memory/time limits
4. Works in browser and Tauri
5. Battle-tested (Figma plugins, etc.)

### Execution Flow

```typescript
// lib/services/isomorphic/script-sandbox.ts
import { getQuickJS } from 'quickjs-emscripten';
import ts from 'typescript';

const MEMORY_LIMIT = 10 * 1024 * 1024; // 10MB
const EXECUTION_TIMEOUT_MS = 100;

export async function executeScript(
	input: string,
	code: string,
): Promise<Result<string, string>> {
	// 1. Strip TypeScript types
	const jsCode = stripTypes(code);
	if (jsCode.error) return Err(jsCode.error);

	// 2. Create QuickJS context
	const QuickJS = await getQuickJS();
	const vm = QuickJS.newContext();

	try {
		// 3. Set resource limits
		vm.runtime.setMemoryLimit(MEMORY_LIMIT);
		const startTime = Date.now();
		vm.runtime.setInterruptHandler(
			() => Date.now() - startTime > EXECUTION_TIMEOUT_MS,
		);

		// 4. Inject input variable
		const inputHandle = vm.newString(input);
		vm.setProp(vm.global, 'input', inputHandle);
		inputHandle.dispose();

		// 5. Wrap and execute
		const wrappedCode = `(function() { ${jsCode.data} })()`;
		const result = vm.evalCode(wrappedCode);

		// 6. Handle result
		if (result.error) {
			const error = vm.dump(result.error);
			result.error.dispose();
			return Err(String(error));
		}

		const output = vm.dump(result.value);
		result.value.dispose();

		if (typeof output !== 'string') {
			return Err(`Script must return a string, got ${typeof output}`);
		}

		return Ok(output);
	} finally {
		vm.dispose();
	}
}

function stripTypes(code: string): Result<string, string> {
	try {
		const result = ts.transpileModule(code, {
			compilerOptions: {
				target: ts.ScriptTarget.ES2020,
				module: ts.ModuleKind.None,
				strict: false,
			},
		});
		return Ok(result.outputText);
	} catch (e) {
		return Err(`TypeScript error: ${e.message}`);
	}
}
```

## UI Configuration (MVP)

**File:** `apps/whispering/src/lib/components/transformations-editor/Configuration.svelte`

```svelte
{:else if step.type === 'script'}
  <div class="space-y-4">
    <Field.Field>
      <Field.Label for="script.code">Transformation Script</Field.Label>
      <Textarea
        id="script.code"
        value={step['script.code']}
        oninput={(e) => {
          transformation = {
            ...transformation,
            steps: transformation.steps.map((s, i) =>
              i === index
                ? { ...s, 'script.code': e.currentTarget.value }
                : s,
            ),
          };
        }}
        placeholder={`// Transform the input text
// Access input via the 'input' variable
// Return the transformed string

return input
  .replace(/um|uh/gi, '')
  .replace(/\\s+/g, ' ')
  .trim();`}
        rows={10}
        class="font-mono text-sm"
      />
      <Field.Description>
        Write JavaScript that transforms the input text.
        Use <code>input</code> to access the text and <code>return</code> the result.
        TypeScript syntax is supported (types are stripped before execution).
      </Field.Description>
    </Field.Field>

    <Alert.Root variant="info">
      <Alert.Title>Examples</Alert.Title>
      <Alert.Description class="space-y-2">
        <details>
          <summary class="cursor-pointer text-sm font-medium">Personal dictionary</summary>
          <pre class="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto">
const dictionary = {
  'john leftie um': 'John Leftium',
  'type script': 'TypeScript',
};
let result = input;
for (const [wrong, correct] of Object.entries(dictionary)) {
  result = result.replace(new RegExp(wrong, 'gi'), correct);
}
return result;</pre>
        </details>
        <details>
          <summary class="cursor-pointer text-sm font-medium">Remove filler words</summary>
          <pre class="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto">
return input
  .replace(/\b(um|uh|like|you know)\b/gi, '')
  .replace(/\s+/g, ' ')
  .trim();</pre>
        </details>
      </Alert.Description>
    </Alert.Root>
  </div>
{/if}
```

## Transformer Integration

**File:** `apps/whispering/src/lib/query/isomorphic/transformer.ts`

```typescript
import { executeScript } from '$lib/services/isomorphic/script-sandbox';

// In handleStep() switch:
case 'script': {
  const code = step['script.code'];

  if (!code.trim()) {
    return Err('Script is empty. Please add transformation code.');
  }

  return executeScript(input, code);
}
```

## Error Handling

```typescript
type ScriptError =
	| { type: 'empty_script' }
	| { type: 'typescript_error'; message: string }
	| { type: 'syntax_error'; message: string }
	| { type: 'runtime_error'; message: string }
	| { type: 'timeout' }
	| { type: 'memory_exceeded' }
	| { type: 'invalid_return_type'; got: string };
```

User-friendly error messages:

- "Script is empty" → "Please add transformation code."
- TypeScript error → Show the TS compiler message
- Syntax error → Show line number if available
- Runtime error → Show the error message
- Timeout → "Script took too long to execute (>100ms). Check for infinite loops."
- Memory exceeded → "Script used too much memory (>10MB)."
- Invalid return → "Script must return a string, got [type]."

## Schema Migration

**Version:** V3

```typescript
export const TransformationStepV3 = TransformationStepV2.merge({
	version: '3',
	'script.code': 'string',
});

// Migration: V2 -> V3
// Add empty script.code field
```

## Implementation Plan

### Phase 1: Core (MVP)

1. Add `quickjs-emscripten` dependency
2. Create `lib/services/isomorphic/script-sandbox.ts`
3. Add schema V3 with `script.code` field
4. Update `handleStep()` in transformer
5. Add textarea UI in Configuration.svelte
6. Add step type constant and label

### Phase 2: Fast-Follow

1. **AI script generation** - prompt-to-code in UI (~2-3 hours)
2. **compromise NLP** - inject library into sandbox (~1-2 hours)
3. **Segments access** - expose timestamps to scripts (after #851)

### Phase 3: Polish (Later)

1. "Test" button to preview output in editor
2. Better error messages with line numbers
3. `console.log` capture for debugging
4. Code editor upgrade (if requested)
5. Snippet library / templates

## Bundle Size Impact

| Package            | Size (gzipped) | Notes                                     |
| ------------------ | -------------- | ----------------------------------------- |
| quickjs-emscripten | ~150KB         | WASM sandbox                              |
| typescript         | ~500KB         | Already in devDeps, lazy-load for runtime |

**Total new bundle:** ~150KB (QuickJS) + lazy-loaded TS transpiler

## Security Checklist

- [x] Memory limit (10MB)
- [x] CPU/time limit (100ms)
- [x] No network access
- [x] No file system access
- [x] No DOM access
- [x] No code generation (`eval`, `Function`)
- [x] No module loading
- [x] Input passed as value, not code
- [x] Output validated as string

## Future Considerations

### 1. Console Capture

Collect `console.log` calls for debugging display.

### 2. Code Editor

Upgrade to CodeMirror if users want syntax highlighting.

### 3. Snippet Sharing

Export/import script snippets.

### 4. AI Generation

"Generate script from description" button.

### 5. Calling Other Transforms from Script

Allow scripts to invoke other transformations by ID/name:

```javascript
// Chain existing transformations with custom logic
const withPunctuation = await transform('punctuation-commands', input);
const withDictionary = await transform('personal-dictionary', withPunctuation);
return withDictionary.replace(/\s+/g, ' ').trim();
```

**Complexity Analysis:**

| Aspect                         | Complexity | Notes                                                           |
| ------------------------------ | ---------- | --------------------------------------------------------------- |
| Async/await in QuickJS         | Medium     | QuickJS supports promises, requires `executePendingJobs()` loop |
| Exposing transform function    | Medium     | Inject host function that calls back into transformer           |
| Circular dependency prevention | Medium     | Detect/prevent A → B → A cycles                                 |
| Timeout handling               | High       | Nested transforms compound time; need aggregate timeout         |
| Error propagation              | Medium     | Nested errors must bubble up clearly                            |

**Implementation requirements:**

- Add async support to sandbox with job queue pumping
- Expose `transform(id: string, text: string): Promise<string>`
- Max depth limit (e.g., 3 levels)
- Aggregate timeout (e.g., 500ms total across all nested calls)
- Decision: allow `prompt_transform` calls or only `find_replace`/`script`?

**Not for MVP** - the "combine everything in one script" approach is sufficient initially.

### 6. NLP Library Access (compromise)

Expose the [compromise](https://github.com/spencermountain/compromise) NLP library inside the sandbox for advanced text transformations.

**What is compromise?**

- Lightweight NLP library (~343KB)
- Client-side, no network calls
- Part-of-speech tagging, verb conjugation, noun pluralization
- Pattern matching with grammar tags (`#Noun`, `#Verb`, `#Adjective`)
- 12k+ GitHub stars, battle-tested

**Example use cases:**

```javascript
// Change all verbs to past tense
const doc = nlp(input);
doc.verbs().toPastTense();
return doc.text();
// "I walk to the store" → "I walked to the store"

// Pluralize all nouns
const doc = nlp(input);
doc.nouns().toPlural();
return doc.text();
// "the cat sat on the mat" → "the cats sat on the mats"

// Extract and list all people mentioned
const doc = nlp(input);
const people = doc.people().out('array');
return `People mentioned: ${people.join(', ')}\n\n${input}`;

// Normalize contractions
const doc = nlp(input);
doc.contractions().expand();
return doc.text();
// "I can't believe it's not butter" → "I can not believe it is not butter"

// Smart find/replace using grammar
const doc = nlp(input);
doc.match('#Adjective #Noun').out('array');
// ['brown fox', 'lazy dog']

// Convert numbers to text
const doc = nlp(input);
doc.numbers().toText();
return doc.text();
// "I have 3 apples" → "I have three apples"
```

**QuickJS Compatibility: VERIFIED**

Tested on 2026-01-21 using `apps/whispering/scripts/test-quickjs-compromise.ts`:

| Test                  | Result | Time |
| --------------------- | ------ | ---- |
| Basic parsing         | PASS   | 42ms |
| Verb tense (past)     | PASS   | 6ms  |
| Verb tense (future)   | PASS   | 7ms  |
| Noun pluralization    | PASS   | 8ms  |
| Contraction expansion | PASS   | 2ms  |
| Number to text        | PASS   | 3ms  |
| Extract people        | PASS   | 2ms  |
| Match with tags       | PASS   | 2ms  |
| Normalize text        | PASS   | 1ms  |

**Key findings:**

- **All 9 tests pass** - compromise works fully in QuickJS
- **No async required** - all operations are synchronous
- **Minimal shimming needed:** Just `var self = globalThis;`
- **Load time:** ~220ms to inject compromise into VM
- **Execution:** Individual NLP operations take 1-8ms
- **Bundle size:** ~343KB for full library

**Implementation approach:**

Since compromise is verified to work in QuickJS, use **Option B: Inject at runtime**:

```typescript
// In script-sandbox.ts
const compromiseSource = await loadCompromiseSource(); // lazy-load once

// Before user code
vm.evalCode('var self = globalThis;');
vm.evalCode(compromiseSource);

// User code can now use nlp()
vm.evalCode(userScript);
```

**Complexity Analysis (Updated):**

| Aspect                | Complexity | Notes                                       |
| --------------------- | ---------- | ------------------------------------------- |
| Bundle size           | Medium     | +343KB (can lazy-load on first script use)  |
| QuickJS compatibility | **None**   | Verified working with minimal shim          |
| API exposure          | Low        | Just inject compromise.js before user code  |
| Memory usage          | Medium     | ~220ms load, but reusable across executions |

**Recommendation:** Can be included in MVP or fast-follow since it's simpler than originally thought. No async, no host-bridge, just inject the library.

**Implementation steps:**

1. Bundle compromise.js as a static asset
2. Lazy-load and cache the source on first script transform
3. Inject `self = globalThis` + compromise source before user code
4. Document the `nlp()` API availability in UI help text

### 7. AI Script Generation (Fast-Follow)

Add a "Generate with AI" section to the script step UI that converts natural language descriptions into working scripts.

**UI Design:**

```svelte
<!-- Collapsible section below the code textarea -->
<Accordion.Root type="single">
	<Accordion.Item value="ai-generate">
		<Accordion.Trigger>Generate with AI</Accordion.Trigger>
		<Accordion.Content>
			<Field.Field>
				<Field.Label>Describe what you want</Field.Label>
				<Textarea
					bind:value={aiPrompt}
					placeholder="Remove filler words like 'um' and 'uh', then capitalize the first letter of each sentence"
					rows={3}
				/>
			</Field.Field>

			<div class="flex gap-2">
				<Select.Root bind:value={selectedProvider}>
					<!-- Reuse INFERENCE_PROVIDER_OPTIONS -->
				</Select.Root>
				<Button onclick={generateScript} disabled={generating}>
					{generating ? 'Generating...' : 'Generate Script'}
				</Button>
			</div>
		</Accordion.Content>
	</Accordion.Item>
</Accordion.Root>
```

**System Prompt:**

```
You are a JavaScript code generator for text transformation scripts.
The user will describe a text transformation they want to perform.
Generate a JavaScript function body that:
- Has access to `input` (string) - the text to transform
- Has access to `segments` (array) - optional timestamp segments [{start, end, text}]
- Must return a string
- Can use standard JS, regex, JSON, etc.
- Do NOT include function declaration, just the body
- Do NOT use async/await, fetch, or external APIs

Example output for "remove filler words":
return input
  .replace(/\b(um|uh|like|you know)\b/gi, '')
  .replace(/\s+/g, ' ')
  .trim();
```

**Behavior:**

- If script textarea is empty: generate new script from prompt
- If script textarea has code: prompt becomes "modify this script to..."
- Extract code from markdown code blocks in AI response
- Show error toast if generation fails

**Complexity:** Low (~2-3 hours)

- Reuses existing `services.completions.*` APIs
- Reuses existing provider/model selectors from prompt_transform step
- No new dependencies

### 8. Timestamp/Segment Access

When transcription timestamps are available (see `specs/whispering-transcription-timestamps.md`), expose them to scripts via a `segments` variable.

**Available variables:**

```javascript
input; // "Hello world. How are you?" (string)
segments; // [{ start: 0, end: 1.2, text: "Hello world." }, ...] (array)
```

**Example use cases:**

```javascript
// Generate SRT subtitles
function formatSRT(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 1000);
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

return segments
	.map(
		(seg, i) =>
			`${i + 1}\n${formatSRT(seg.start)} --> ${formatSRT(seg.end)}\n${seg.text}\n`,
	)
	.join('\n');

// Add timestamps to transcript
return segments.map((s) => `[${s.start.toFixed(1)}s] ${s.text}`).join('\n');

// Filter out short segments (likely noise)
return segments
	.filter((s) => s.end - s.start > 0.5)
	.map((s) => s.text)
	.join(' ');
```

**Implementation (after #851):**

```typescript
// script-sandbox.ts
export async function executeScript(
	input: string,
	code: string,
	context?: { segments?: TranscriptionSegment[] },
) {
	// ... setup ...

	vm.setProp(vm.global, 'input', vm.newString(input));

	const segmentsJson = JSON.stringify(context?.segments ?? []);
	vm.evalCode(`const segments = ${segmentsJson};`);

	// ... run user code ...
}
```

**Complexity:** Low (~20 lines) once timestamps spec is implemented.

**Dependency:** `specs/whispering-transcription-timestamps.md` (#851)

## References

- [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)
- [QuickJS Engine](https://bellard.org/quickjs/)
- [TypeScript transpileModule](https://www.typescriptlang.org/docs/handbook/compiler-options.html)
- [compromise NLP](https://github.com/spencermountain/compromise) - modest natural language processing

### Related Issues

| Issue                                                         | Title                                 | How Script Helps                                          |
| ------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| [#851](https://github.com/EpicenterHQ/epicenter/issues/851)   | Produce audio aligned timestamps      | `segments` variable enables SRT export, timestamp display |
| [#904](https://github.com/EpicenterHQ/epicenter/issues/904)   | Personal dictionary for transcription | Dictionary object with case-insensitive replacements      |
| [#962](https://github.com/EpicenterHQ/epicenter/issues/962)   | Regex transform adds double space     | Combine replacements + space normalization in one pass    |
| [#988](https://github.com/EpicenterHQ/epicenter/issues/988)   | Newline chars in find-replace         | Script can use `\n` directly in string literals           |
| [#1253](https://github.com/EpicenterHQ/epicenter/issues/1253) | Punctuation commands                  | Map spoken words ("comma") to symbols (",")               |
| [#1205](https://github.com/EpicenterHQ/epicenter/issues/1205) | Support multiple transformations      | Single script combines multiple concerns with ordering    |
| [#1208](https://github.com/EpicenterHQ/epicenter/issues/1208) | Run multiple transformations at once  | Same as #1205 - one script, explicit order control        |

### Related Specs

| Spec                                           | Relationship                         |
| ---------------------------------------------- | ------------------------------------ |
| `specs/whispering-transcription-timestamps.md` | Provides `segments` data for scripts |
