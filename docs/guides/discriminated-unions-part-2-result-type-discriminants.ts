/**
 * Understanding Result Type Discriminants: Building to Symmetry
 * Part 2 of 2 - See ./discriminated-union-demo.ts for Part 1
 *
 * The Result type can be written multiple ways. This guide shows why
 * having BOTH properties present in ALL variants is the key insight.
 *
 * PREREQUISITE: Start with "./discriminated-union-demo.ts" first.
 * This guide assumes you understand Pattern 2 (data property as discriminant).
 */

// ============================================================================
// The Problem: Omitting Properties Breaks Type Safety
// ============================================================================

/*
 * You might try to write a Result type where only one property exists
 * per variant. This seems simpler, but it doesn't work:
 */

// ❌ Attempt 1: Only error variant has 'error'
type ResultDataOnly<T, E> =
  | { data: T }                 // Success: I have data
  | { data: null; error: E };   // Failure: no data, but I have error

function handleDataOnly<T, E>(result: ResultDataOnly<T, E>) {
  if (result.data !== null) {
    const value: T = result.data;
    console.log("Success:", value);
  } else {
    // ❌ Type error! 'error' doesn't exist on the union
    // TypeScript doesn't know 'error' exists after narrowing on 'data'
    // const err: E = result.error;
  }
}

// ❌ Attempt 2: Only success variant has 'data'
type ResultErrorOnly<T, E> =
  | { data: T; error: null }  // Success: no error, I have data
  | { error: E };             // Failure: I have error

function handleErrorOnly<T, E>(result: ResultErrorOnly<T, E>) {
  if (result.error !== null) {
    const err: E = result.error;
    console.error("Error:", err);
  } else {
    // ❌ Type error! 'data' doesn't exist on the union
    // TypeScript doesn't know 'data' exists after narrowing on 'error'
    // const value: T = result.data;
  }
}

/*
 * Why these fail:
 * - The discriminant ('data' or 'error') IS present in both variants
 * - But the OTHER property is omitted from one variant
 * - TypeScript can narrow the discriminant, but can't guarantee
 *   the other property exists
 *
 * The fix: Make BOTH properties present in ALL variants.
 */

// ============================================================================
// The Solution: Both Properties in All Variants
// ============================================================================

/*
 * When BOTH properties are present in ALL variants, TypeScript can
 * narrow on EITHER property. This is the symmetric pattern from Part 1.
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
 * This is the symmetrical pattern (Pattern 3 from discriminated-union-demo.ts):
 *
 * When you make BOTH properties complete, you get symmetry.
 * Check whichever property makes sense in your context!
 *
 * The key insight: This Result type IS a discriminated union.
 * It's Pattern 2 (data property as discriminant) applied to BOTH properties.
 * That's why either property can narrow the type.
 */

// ============================================================================
// The Journey Complete
// ============================================================================

/*
 * The symmetric Result type is just Pattern 2 applied twice:
 * - 'data' is a discriminant (T vs null)
 * - 'error' is a discriminant (null vs E)
 *
 * Both properties present + distinguishable values = BOTH can discriminate.
 *
 * This is the power of symmetrical nullability:
 * - Maximum flexibility
 * - Clear intent (mutually exclusive properties)
 * - Either property can discriminate independently
 *
 * Now you understand why Pattern 3 (symmetrical nullability) works!
 */
