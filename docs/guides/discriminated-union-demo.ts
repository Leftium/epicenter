/**
 * Discriminated Unions in TypeScript: Three Common Patterns
 *
 * All discriminated unions work the same way: distinguishable values across variants.
 * That's the core principle. But how you apply it varies.
 *
 * This guide covers the three most common patterns I see in TypeScript codebases.
 * There are others, but these three will handle most of your use cases.
 */

// ============================================================================
// THE CORE PRINCIPLE
// ============================================================================

/*
 * A discriminant is any property with distinguishable values across variants.
 *
 * That's it. Whether it's:
 * - String literals: "url" vs "file" vs "text"
 * - Numbers: 200 vs 404 vs 500
 * - Types: Blob vs undefined vs null
 * - Booleans: true vs false
 *
 * If TypeScript can tell the values apart, it can narrow the type.
 *
 * The patterns below show the most common ways to apply this principle.
 */

// ============================================================================
// QUICK REFERENCE
// ============================================================================

/*
 * PATTERN 1: Classical Dedicated Field
 *    type T = { type: 'a'; data: string } | { type: 'b'; data: number } | { type: 'c'; data: boolean }
 *    Approach: A dedicated field (usually 'type') with distinguishable values
 *    When: 3+ variants, or when clarity is paramount
 *
 * PATTERN 2: Nullable Property
 *    type T = { blob: Blob } | { blob: undefined }
 *    Approach: A single property that's either present (Blob) or absent (undefined/null)
 *    When: 2 variants, property being null/undefined is meaningful
 *
 * PATTERN 3: Symmetrical Nullability (builds on Pattern 2)
 *    type T = { data: T; error: undefined } | { data: undefined; error: E }
 *    Approach: Two properties, each can be null/undefined in opposite variants
 *    When: 2 variants, two mutually exclusive concepts (data/error, success/failure)
 *    Key insight: BOTH properties can discriminate independently!
 *    ⚠️  Requires explicit undefined - omission fails for this pattern!
 */

// ============================================================================
// Pattern 1: Classical Dedicated Field
// ============================================================================

/*
 * This is the standard pattern everyone knows. You have a reserved field
 * (usually called 'type', 'kind', or 'tag') that identifies which variant
 * you're dealing with.
 *
 * The key: the discriminant has distinguishable values across variants.
 * Strings are conventional, but ANY distinguishable type works.
 *
 * Works for any number of variants. Three variants, ten variants, doesn't matter.
 */

// Example 1: String discriminants (most common)
type FileUpload =
  | {
      type: "url";
      url: string;
    }
  | {
      type: "file";
      file: File;
    }
  | {
      type: "text";
      text: string;
    };

function handleUpload(upload: FileUpload) {
  if (upload.type === "url") {
    console.log("Fetching from:", upload.url);
  } else if (upload.type === "file") {
    console.log("Processing file:", upload.file.name);
  } else {
    console.log("Processing text:", upload.text);
  }
}

// Example 2: Number discriminants (also works!)
type HttpResponse =
  | { status: 200; data: unknown }
  | { status: 404; error: "Not Found" }
  | { status: 500; error: "Server Error" };

function handleResponse(response: HttpResponse) {
  if (response.status === 200) {
    console.log("Data:", response.data);
  } else if (response.status === 404) {
    console.log("Not found");
  } else {
    console.log("Server error");
  }
}

// Example 3: Boolean discriminants (yes, even booleans!)
type LoadState =
  | { loaded: true; data: string }
  | { loaded: false; error: Error };

function useLoadState(state: LoadState) {
  if (state.loaded) {
    console.log("Data:", state.data);
  } else {
    console.log("Error:", state.error);
  }
}

/*
 * The pattern: A dedicated field with distinguishable values.
 *
 * The 'type' field must be present in all variants. That's what makes it
 * a discriminant. Each variant has a different value ('url', 'file', 'text'),
 * but the property itself exists everywhere.
 *
 * Key principle: To be a discriminant, a property must:
 * 1. Be present in ALL variants (not omitted from any)
 * 2. Have distinguishable values across variants
 *
 * - Strings are conventional and readable ("url", "file", "text")
 * - Numbers work great for status codes (200, 404, 500)
 * - Booleans work for binary states (true/false)
 * - ANY type with distinguishable values can be a discriminant
 *
 * When this pattern makes sense:
 * - You have 3 or more variants (or even 2 when clarity is paramount)
 * - Clarity is important (anyone can understand this)
 * - You're building a public API
 * - You want to make future additions easy (just add another value)
 */

// ============================================================================
// Pattern 2: Nullable Property
// ============================================================================

/*
 * When you have exactly 2 variants and a single property, you don't need
 * a reserved discriminant field. The property's nullability itself becomes
 * the discriminant.
 *
 * Just like Pattern 1, the key is distinguishable values. But here,
 * instead of string literals ("url" vs "file"), we use the actual type
 * of the property (Blob vs undefined/null) as the discriminant.
 *
 * The property is either defined (one variant) or null/undefined (other variant).
 * It's not metadata about your data; it's the actual data doing double-duty.
 */

type RecordingSource =
  | {
      blob: Blob;           // blob is Blob (discriminant value #1)
      blobSize: number;     // Additional properties for this variant
      blobType: string;
    }
  | {
      blob: undefined;      // blob is undefined (discriminant value #2)
      filePath: string;     // Different properties for this variant
      fileFormat: string;
    };

function useRecording(source: RecordingSource) {
  if (source.blob !== undefined) {
    // We have a blob variant
    console.log("Blob size:", source.blob.size);
    console.log("Stored size:", source.blobSize);
    console.log("Type:", source.blobType);
    // source.filePath doesn't exist here
    // source.fileFormat doesn't exist here
  } else {
    // We have a file path variant
    console.log("File path:", source.filePath);
    console.log("Format:", source.fileFormat);
    // source.blob is undefined here
    // source.blobSize doesn't exist here
    // source.blobType doesn't exist here
  }
}

/*
 * Why not just omit the undefined?
 *
 * You might wonder: "Why write { blob: undefined; ... } instead of just
 * { filePath: string; fileFormat: string }?"
 *
 * You technically can omit it and use the 'in' operator to check for presence:
 */

type RecordingSourceOmitted =
  | {
      blob: Blob;
      blobSize: number;
      blobType: string;
    }
  | {
      filePath: string;
      fileFormat: string;
    };

function useRecordingOmitted(source: RecordingSourceOmitted) {
  if ("blob" in source) {
    // ✅ The 'in' operator DOES narrow correctly here
    console.log("Blob size:", source.blob.size);
    console.log("Stored size:", source.blobSize);
    // TypeScript knows this is the blob variant
  } else {
    // ✅ TypeScript knows this is the file path variant
    console.log("File path:", source.filePath);
    console.log("Format:", source.fileFormat);
  }
}

/*
 * The 'in' operator works for Pattern 2!
 *
 * With omission, the 'in' operator narrows correctly because 'blob' only
 * exists in one variant. TypeScript can use presence/absence to discriminate.
 *
 * Why does 'in' work here but not for Pattern 3?
 * - Pattern 2: Only ONE property needs to be complete (present in all variants)
 * - With omission: 'blob' exists in variant 1, doesn't exist in variant 2
 * - The 'in' check effectively discriminates: "blob" in source → variant 1
 * - result.blob !== undefined would also work with explicit undefined
 *
 * So why prefer explicit undefined?
 *
 * 1. Consistency: 'blob' is always accessible (just undefined in one variant)
 * 2. Intent: Makes it clear that 'blob' IS the discriminant property
 * 3. Uniformity: Use the same check pattern (blob !== undefined) everywhere
 * 4. Type safety: Checking value vs existence are semantically different
 *
 * Both approaches work for Pattern 2. Explicit undefined is clearer about
 * what's serving as the discriminant, but omission with 'in' is valid if you
 * prefer checking property existence.
 *
 * When this pattern makes sense:
 * - You have exactly 2 variants
 * - One property that's naturally optional
 * - The presence/absence of that property IS the meaningful distinction
 * - Example: loaded/not loaded, cached/not cached, authenticated/not authenticated
 */

// ============================================================================
// Pattern 3: Symmetrical Nullability
// ============================================================================

/*
 * This is the data/error pattern. Here's the key insight:
 *
 * Pattern 2 is about making ONE property nullable as the discriminant.
 * Pattern 3 is about making BOTH properties nullable (in opposite variants).
 *
 * When you apply the "nullable property" pattern to BOTH properties
 * symmetrically, you get a type where you can check EITHER property to narrow.
 */

type Result<T, E> =
  | { data: T; error: undefined }      // 'data' is the discriminant: T vs undefined
  | { data: undefined; error: E };     // 'error' is the discriminant: undefined vs E
                                       // BOTH are discriminants!

function handleResult<T, E>(result: Result<T, E>) {
  // Discriminate on error:
  if (result.error !== undefined) {
    console.error("Error:", result.error);
    return;
  }

  // We have data:
  console.log("Success:", result.data);
}

function handleResult2<T, E>(result: Result<T, E>) {
  // Or discriminate on data (symmetrical!):
  if (result.data !== undefined) {
    console.log("Success:", result.data);
  } else {
    console.error("Error:", result.error);
  }
}

/*
 * Why must both properties be present (one as undefined)?
 *
 * You might wonder: "Why not just { data: T } | { error: E }?"
 *
 * For symmetry to work, BOTH properties must be present in ALL variants.
 * That's what makes them BOTH discriminants. Each property can narrow the type
 * independently because each has distinguishable values across variants.
 *
 * This is different from Pattern 2!
 * - Pattern 2: ONE property is complete → 'in' operator works with omission
 * - Pattern 3: BOTH properties must be complete → 'in' operator fails with omission
 *
 * With omission, TypeScript can't enforce mutual exclusivity at compile time.
 * Nothing prevents creating an object with BOTH properties at runtime:
 */

// ❌ Omission fails:
type ResultOmitted<T, E> =
  | { data: T }
  | { error: E };

function demonstrateProblem<T, E>(result: ResultOmitted<T, E>) {
  // 🚨 Type narrowing with 'in' fails!
  if ("data" in result) {
    // You'd expect result.data to be T, but it's T | undefined
    // const d: T = result.data; // ❌ Error!

    // Why? Because nothing prevents this at runtime:
    // const both = { data: "value", error: "error" };
    // TypeScript must assume both might exist!
  }

  // 🚨 Even checking the value doesn't help with omission!
  if (result.data !== undefined) {
    // result.data is STILL T | undefined (not T)
    // const d: T = result.data; // ❌ Error!
  }
}

// TypeScript can't prevent an object with BOTH properties:
const ambiguous: ResultOmitted<string, string> = {
  data: "value",
  // @ts-expect-error - TypeScript can't prevent this at compile time!
  error: "error",
};
// Result: result.data becomes T | undefined, not T
// TypeScript can't enforce mutual exclusivity with omitted keys

// ✅ Explicit undefined fixes this:
type ResultFixed<T, E> =
  | { data: T; error: undefined }
  | { data: undefined; error: E };

function demonstrateSolution<T, E>(result: ResultFixed<T, E>) {
  // ✅ Type narrowing works!
  if (result.error !== undefined) {
    const e: E = result.error; // Works!
  } else {
    const d: T = result.data; // Works!
  }
}

/*
 * Why does explicit undefined work?
 * Because both properties MUST exist (one as undefined).
 * TypeScript enforces mutual exclusivity at compile time:
 *
 * const valid: ResultFixed<string, string> = {
 *   data: "value",
 *   error: undefined, // Required!
 * };
 *
 * const invalid: ResultFixed<string, string> = {
 *   data: "value",
 *   error: "error", // ❌ Error: both can't be defined!
 * };
 *
 * This is why Pattern 3 REQUIRES explicit undefined. The discriminant must
 * be present in all variants. For symmetry, BOTH properties must be discriminants,
 * so BOTH must be present in all variants.
 *
 * Key insight: "error" in result vs result.error !== undefined are NOT the same!
 * - "error" in result: Checks if property exists (presence)
 * - result.error !== undefined: Checks the property's value
 *
 * For Pattern 3, you MUST check the value (result.error !== undefined).
 * The 'in' operator won't narrow correctly with omission because TypeScript
 * can't guarantee mutual exclusivity at runtime.
 */

/*
 * When this pattern makes sense:
 * - You have exactly 2 variants
 * - Two mutually exclusive concepts: data/error, success/failure, old/new
 * - Either concept could be "the thing you check first" (symmetrical checking)
 * - You want both properties always present for easier access
 *
 * Remember: This is just Pattern 2 (nullable property) applied to BOTH
 * properties instead of just one. Each property can discriminate independently.
 */

// ============================================================================
// Pattern 3 with Base Properties: Recording Example
// ============================================================================

/*
 * Symmetrical discriminants shine when you have base properties shared across
 * variants plus mutually exclusive variant-specific properties.
 */

type Recording =
  | {
      // Base properties (always present)
      id: string;
      title: string;
      content: string;
      // Variant-specific properties (mutually exclusive)
      audioFileSource: string;
      blob: undefined;
    }
  | {
      // Base properties (always present)
      id: string;
      title: string;
      content: string;
      // Variant-specific properties (mutually exclusive)
      audioFileSource: undefined;
      blob: Blob;
    };

function processRecording(recording: Recording) {
  // Access base properties freely (always available)
  console.log("Processing:", recording.title);
  console.log("ID:", recording.id);
  console.log("Content:", recording.content);

  // Discriminate on either variant property:
  if (recording.audioFileSource !== undefined) {
    console.log("Loading from file:", recording.audioFileSource);
  } else {
    console.log("Processing blob:", recording.blob.size, "bytes");
  }
}

function processRecording2(recording: Recording) {
  // Or discriminate on the other property:
  if (recording.blob !== undefined) {
    console.log("Blob size:", recording.blob.size);
  } else {
    console.log("File path:", recording.audioFileSource);
  }
}

/*
 * Why not add a 'type' field here?
 * Because we have exactly 2 variants, and the properties themselves can act
 * as discriminants. The explicit undefined makes this work.
 *
 * You could add a type field if you wanted to (Pattern 1). That's a
 * valid choice. This pattern just shows you don't have to.
 */


// ============================================================================
// Breaking the Symmetry: Back to Pattern 2
// ============================================================================

/*
 * When you only make ONE property complete (present in all variants),
 * you're back to regular Pattern 2. The symmetry is gone.
 *
 * This is valid! Sometimes you don't need symmetry. You just want to
 * discriminate on one property.
 */

type AsymmetricResult<T, E> =
  | { data: T }
  | { error: E; data: null };

function handleAsymmetric<T, E>(result: AsymmetricResult<T, E>) {
  // Only error can discriminate (data is present in both variants)
  if ("error" in result) {
    console.error("Error:", result.error);
    // result.data is null here
  } else {
    console.log("Success:", result.data);
    // result.data is T here
  }

  // You can't discriminate on data (it's present in both variants):
  // if (result.data !== null) { ... } // Doesn't narrow properly
}

/*
 * When asymmetric makes sense:
 * - One variant is "the default" (just data)
 * - Other variant adds extra info (error, and data becomes null)
 * - You always check for the "special case" (error) first
 */

// ============================================================================
// Summary: Choosing Your Pattern
// ============================================================================

/*
 * THE UNIFYING PRINCIPLE:
 *
 * A discriminant is any property with distinguishable values across variants.
 *
 * - Pattern 1: Dedicated field, any distinguishable type
 *   (strings are conventional, but numbers, booleans, etc. all work)
 *
 * - Pattern 2: Data property itself has distinguishable values
 *   (Blob vs undefined, string vs null, etc.)
 *
 * - Pattern 3: TWO data properties, each with distinguishable values
 *   (data: T vs undefined, error: undefined vs E)
 *
 * All three patterns use the same TypeScript mechanism: distinguishable values.
 * They just differ in WHERE those distinguishable values come from.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * PATTERN 1: Classical Dedicated Field
 * type FileUpload =
 *   | { type: 'url'; url: string }
 *   | { type: 'file'; file: File }
 *   | { type: 'text'; text: string }
 *
 * When:
 * - 3+ variants (or 2 when clarity is paramount)
 * - Clarity is paramount
 * - Building a public API
 * - Future maintainers might not know advanced patterns
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * PATTERN 2: Nullable Property
 * type RecordingSource =
 *   | { blob: Blob }
 *   | { blob: undefined }
 *
 * When:
 * - Exactly 2 variants
 * - Single property that's naturally nullable
 * - Nullability IS the distinction
 * - Examples: loaded/not loaded, cached/not cached
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * PATTERN 3: Symmetrical Nullability (builds on Pattern 2)
 * type Result<T, E> =
 *   | { data: T; error: undefined }
 *   | { data: undefined; error: E }
 *
 * When:
 * - Exactly 2 variants
 * - Two mutually exclusive concepts (data/error, success/failure)
 * - Either property could be "the thing you check first" (symmetrical)
 * - Want both properties always present
 *
 * Key insight: This is Pattern 2 applied to BOTH properties!
 * Each property can discriminate independently.
 *
 * ⚠️  Must use explicit undefined (omission fails for this pattern!)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * All patterns are valid. None is universally "best."
 * Choose based on your use case.
 */
