# Typia Goes From TypeScript to JavaScript, Not the Other Way Around

Every validation library I've used works the same way: define a schema in JavaScript, derive a TypeScript type from it.

```typescript
// Zod: JS → TS
const User = z.object({ name: z.string(), age: z.number() });
type User = z.infer<typeof User>;

// Arktype: JS → TS (with a TS-like DSL)
const User = type({ name: 'string', age: 'number' });
type User = typeof User.infer;

// TypeBox: JS → TS
const User = Type.Object({ name: Type.String(), age: Type.Number() });
type User = Static<typeof User>;
```

Typia flips the arrow. You write a plain TypeScript type, and a compiler generates a runtime validator from it:

```typescript
// Typia: TS → JS
interface User {
	name: string;
	age: number;
}

const check = typia.createIs<User>();
```

At build time, Typia's AOT compiler reads the TypeScript type and replaces that call with generated JavaScript:

```javascript
// What actually ships to production:
const check = (input) =>
	'object' === typeof input &&
	null !== input &&
	'string' === typeof input.name &&
	'number' === typeof input.age;
```

No schema object. No runtime interpretation. The TypeScript type is the single source of truth, and the compiler does the rest.

## How the compiler works

Typia hooks into the TypeScript compiler via `ts-patch` (or `unplugin-typia` for Vite/webpack/esbuild). During compilation:

```
TypeScript Source          Typia Transformer           JavaScript Output
       │                         │                           │
       │   typia.is<User>()      │                           │
       │────────────────────────>│                           │
       │                         │  analyze User type        │
       │                         │  extract metadata         │
       │                         │  generate validation AST  │
       │                         │──────────────────────────>│
       │                         │                           │
       │                    (input) => "object" === typeof input && ...
```

The transformer detects `typia.*` calls, resolves the generic type parameter using TypeScript's compiler API, and replaces the call with optimized validation code. The output is pure JavaScript with zero runtime dependency on Typia.

## Where the "just TypeScript" claim breaks down

Structural validation really is just TypeScript. Interfaces, type aliases, unions, intersections, tuples, nested objects: all work without any Typia-specific syntax.

Semantic validation is a different story. If you need to check that a string is an email or a number falls in a range, you need Typia's phantom types:

```typescript
import typia, { tags } from 'typia';

interface User {
	id: string & tags.Format<'uuid'>;
	email: string & tags.Format<'email'>;
	age: number & tags.ExclusiveMinimum<19> & tags.Maximum<100>;
}
```

These `tags.*` intersections are phantom types that carry no runtime value. The compiler reads them during transformation and generates the appropriate checks. But they're imports from `typia`; without the compiler, they're meaningless. That's vendor lock-in for anything beyond structural validation.

The lock-in is one-directional though. `string & tags.Format<"email">` is a subtype of `string`, so validated values work everywhere plain strings are expected. You only need the branded type at the validation boundary.

## Performance

Typia's generated code is fast because there's nothing to interpret at runtime. The benchmarks are real:

| Test Case           | Typia        | TypeBox      | Zod      |
| ------------------- | ------------ | ------------ | -------- |
| Simple object       | 199,973 MB/s | 199,500 MB/s | 115 MB/s |
| Hierarchical object | 192,189 MB/s | 34,833 MB/s  | 63 MB/s  |
| Recursive object    | 24,531 MB/s  | 20,977 MB/s  | 11 MB/s  |

For simple objects, Typia and TypeBox are roughly equal; both use ahead-of-time compilation. For hierarchical and recursive types, Typia pulls ahead significantly. Against Zod, it's not even close: 1,700x faster on simple objects, 3,000x on hierarchical.

JSON serialization is similarly fast. `typia.json.assertStringify<T>()` generates type-specific serializers that run 8-16x faster than `JSON.stringify`.

## Things Typia does that nobody else does

LLM function calling schemas. `typia.llm.application<Class>()` generates schemas for Claude, GPT, and Gemini function calling directly from TypeScript types. No manual JSON Schema authoring.

Protocol Buffer encoding. `typia.protobuf.assertEncode<T>()` goes from TypeScript type to protobuf binary without `.proto` files.

Implicit union discrimination. Given a union of object types, Typia figures out which variant matches without explicit discriminant fields. Other libraries require you to tag unions explicitly.

Random data generation. `typia.random<T>()` generates valid test data from any type, respecting format tags.

## The trade-offs

No data transformations. Zod has `.transform()`, arktype has morphs, Typia only validates. If you need to trim strings, normalize emails, or parse date strings during validation, you'll do it in a separate step.

Build toolchain requirement. You need `ts-patch` to patch the TypeScript compiler, or `unplugin-typia` for bundler integration. Compare that to `npm install zod` and you're done. The `npx typia setup` wizard handles most of it, but it's still an extra moving part.

TypeScript version ceiling. Typia currently requires `>=4.8.0 <5.10.0`. When a new TypeScript release ships, you wait for Typia to catch up.

Compilation speed. The transformer analyzes types using TypeScript's compiler API, which is expensive. Users report ~15 seconds for ~15 files in large codebases. Deeply nested types (like schema.org's type definitions) can cause OOM crashes.

Smaller ecosystem. Zod has hundreds of integrations. Typia has Nestia (NestJS), unplugin-typia, and a handful of others. The library is actively maintained (243K weekly npm downloads, v11.0.3), but the plugin ecosystem is thin.

## The direction spectrum

| Library | Direction | You Write                          | You Get            |
| ------- | --------- | ---------------------------------- | ------------------ |
| Zod     | JS → TS   | `z.string().email()`               | Type via `z.infer` |
| TypeBox | JS → TS   | `Type.String({ format: "email" })` | Type via `Static`  |
| Arktype | JS ↔ TS   | `"string.email"`                   | Type via `.infer`  |
| Typia   | TS → JS   | `string & tags.Format<"email">`    | Validator via AOT  |

Most libraries invented a JavaScript DSL and figured out how to derive TypeScript types from it. Typia starts with TypeScript and figures out how to derive JavaScript from it. Both approaches have a DSL for semantic constraints; they just embed it differently.

For pure structural validation though, Typia is the only one where you write nothing but TypeScript. No builder functions, no string DSLs, no schema objects. Just a type and a function call that disappears at compile time.

Whether that's worth the build complexity depends on what you're building. High-throughput API servers that already have TypeScript types defined: strong fit. Frontend apps that need form validation with transforms: probably not.

For the specific use case of validating types from external libraries without reimplementing them as schemas, see [Typia Validates External Types With Zero Duplication](./typia-validates-external-types-zero-duplication.md).
