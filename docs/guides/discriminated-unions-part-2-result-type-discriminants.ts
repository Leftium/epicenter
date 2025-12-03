/**
 * Understanding Result Type Discriminants: Building to Symmetry
 * Part 2 of 2 - See ./discriminated-union-demo.ts for Part 1
 *
 * The Result type can be written multiple ways. Each reveals something
 * important about discriminants. Let's build up from simple to symmetrical.
 *
 * PREREQUISITE: Start with "./discriminated-union-demo.ts" first.
 * This guide assumes you understand Pattern 2 (nullable property as discriminant).
 */

// ============================================================================
// Starting Simple: Data as the Only Discriminant
// ============================================================================

/*
 * Let's start with the simplest approach: only 'data' acts as the discriminant.
 *
 * The question we're answering: "Do I have data?"
 * - If yes: use it
 * - If no: handle the error
 */

type ResultDataOnly<T, E> =
  | { data: T }                 // Success: I have data
  | { data: null; error: E };   // Failure: no data, but I have error

function handleDataOnly<T, E>(result: ResultDataOnly<T, E>) {
  // Check data (it's present in BOTH variants)
  if (result.data !== null) {
    // ✅ We have data!
    const value: T = result.data;
    console.log("Success:", value);
    // result.error doesn't exist here
  } else {
    // ✅ No data, so we have error
    const err: E = result.error;
    console.error("Error:", err);
  }
}

/*
 * Why this works:
 * - 'data' is present in BOTH variants (T or null)
 * - 'error' only exists in the second variant
 * - Only 'data' can discriminate
 *
 * When this makes sense:
 * - Your primary question is "Do I have data to work with?"
 * - Success is the main path, errors are secondary
 * - Example: "Did the fetch succeed? If yes, render. If no, show error."
 */

// ============================================================================
// Mirror Image: Error as the Only Discriminant
// ============================================================================

/*
 * Now let's flip it: only 'error' acts as the discriminant.
 *
 * The question we're answering: "Did something go wrong?"
 * - If yes: handle the error
 * - If no: proceed with data
 */

type ResultErrorOnly<T, E> =
  | { data: T; error: null }   // Success: no error, I have data
  | { error: E };              // Failure: I have error

function handleErrorOnly<T, E>(result: ResultErrorOnly<T, E>) {
  // Check error (it's present in BOTH variants)
  if (result.error !== null) {
    // ✅ We have an error!
    const err: E = result.error;
    console.error("Error:", err);
    // result.data doesn't exist here
  } else {
    // ✅ No error, so we have data
    const value: T = result.data;
    console.log("Success:", value);
  }
}

/*
 * Why this works:
 * - 'error' is present in BOTH variants (E or null)
 * - 'data' only exists in the first variant
 * - Only 'error' can discriminate
 *
 * When this makes sense:
 * - Your primary question is "Did something fail?"
 * - Error handling is the main concern
 * - Example: "Did the operation fail? If yes, retry. If no, continue."
 */

// ============================================================================
// The Pattern: Single Property as Discriminant
// ============================================================================

/*
 * Both approaches above follow the same pattern:
 *
 * ONE property is complete (present in all variants with different types).
 * That property becomes the discriminant.
 *
 * DataOnly:  'data' is complete (T vs null)
 * ErrorOnly: 'error' is complete (null vs E)
 *
 * This is Variation 2 from discriminated-union-demo.ts applied to Result types.
 */

// ============================================================================
// The Revelation: What If BOTH Are Complete?
// ============================================================================

/*
 * Here's the interesting question: What happens if we make BOTH
 * properties complete (present in all variants)?
 *
 * Let's try it:
 */

type Result<T, E> =
  | { data: T; error: null }      // 'data' is complete: T vs null
  | { data: null; error: E };     // 'error' is complete: null vs E
                                  // ↑ BOTH are complete!

/*
 * Wait... now BOTH properties are discriminants!
 * - 'data' can discriminate (T vs null)
 * - 'error' can discriminate (null vs E)
 *
 * This means we can check EITHER property to narrow the type!
 */

function handleResult<T, E>(result: Result<T, E>) {
  // Option 1: Check error first
  if (result.error !== null) {
    const err: E = result.error;     // ✅ error is E
    console.error("Error:", err);
    // result.data is null here
    return;
  }

  const value: T = result.data;       // ✅ data is T
  console.log("Success:", value);
  // result.error is null here
}

function handleResult2<T, E>(result: Result<T, E>) {
  // Option 2: Check data first (equally valid!)
  if (result.data !== null) {
    const value: T = result.data;     // ✅ data is T
    console.log("Success:", value);
    // result.error is null here
  } else {
    const err: E = result.error;       // ✅ error is E
    console.error("Error:", err);
    // result.data is null here
  }
}

/*
 * This is the symmetrical pattern (Variation 3 from discriminated-union-demo.ts):
 *
 * When you make BOTH properties complete, you get symmetry.
 * Check whichever property makes sense in your context!
 *
 * The AHA moment:
 * - ResultDataOnly: Only data discriminates
 * - ResultErrorOnly: Only error discriminates
 * - Result: BOTH discriminate! (combining the two patterns)
 */

// ============================================================================
// Side-by-Side Comparison
// ============================================================================

/*
 * Let's see all three approaches with the same type:
 */

declare const result1: ResultDataOnly<string, Error>;
declare const result2: ResultErrorOnly<string, Error>;
declare const result3: Result<string, Error>;

// DataOnly: Must check data
if (result1.data !== null) {
  result1.data; // string
} else {
  result1.error; // Error
}

// ErrorOnly: Must check error
if (result2.error !== null) {
  result2.error; // Error
} else {
  result2.data; // string
}

// Symmetrical: Can check EITHER!
if (result3.data !== null) {
  result3.data; // string
}
if (result3.error !== null) {
  result3.error; // Error
}

// ============================================================================
// When to Use Each Approach
// ============================================================================

/*
 * DATA-ONLY DISCRIMINANT (ResultDataOnly):
 * Use when:
 * - Success is your primary concern
 * - You always ask "Do I have data?" first
 * - Errors are secondary
 * - Example: "Did I get the user profile? If yes, render it."
 *
 * ERROR-ONLY DISCRIMINANT (ResultErrorOnly):
 * Use when:
 * - Errors are your primary concern
 * - You always ask "Did something fail?" first
 * - Success is just "no error occurred"
 * - Example: "Did the save fail? If yes, show error toast."
 *
 * SYMMETRICAL (Result):
 * Use when:
 * - Both success and failure are equally important
 * - Different code paths might check different properties
 * - You want maximum flexibility
 * - You're building a general-purpose Result type library
 * - Example: API responses where you might check either property
 */

// ============================================================================
// Why Explicit Null/Undefined Is Required (For Symmetry)
// ============================================================================

/*
 * Important: For symmetrical discriminants to work, you MUST use explicit
 * null/undefined. Property omission breaks symmetry.
 *
 * See "./discriminated-union-demo.ts" Pattern 3 for the full explanation
 * of why omission fails and explicit null/undefined is required.
 *
 * Quick summary:
 * - Single discriminants (Pattern 2): Omission can work with 'in' operator
 * - Symmetrical discriminants (Pattern 3): MUST use explicit null/undefined
 * - "prop" in obj vs obj.prop !== null: NOT the same for symmetrical patterns!
 */

// ============================================================================
// The Journey Complete
// ============================================================================

/*
 * We started with simple patterns:
 * 1. Check data (single discriminant)
 * 2. Check error (single discriminant)
 *
 * We discovered symmetry:
 * 3. Make BOTH complete → check either (symmetrical discriminants!)
 *
 * This is the power of symmetrical nullability:
 * - Maximum flexibility
 * - Clear intent (mutually exclusive properties)
 * - Either property can discriminate independently
 *
 * Now you understand why Variation 3 (symmetrical nullability) works
 * and when to choose each Result type pattern!
 */
