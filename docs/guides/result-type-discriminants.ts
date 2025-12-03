/**
 * Understanding Result Type Discriminants: Building to Symmetry
 *
 * The Result type can be written multiple ways. Each reveals something
 * important about discriminants. Let's build up from simple to symmetrical.
 *
 * If you're new to discriminated unions, start with "discriminated-union-demo.ts" first.
 * This article assumes you understand Variation 2 (nullable property as discriminant).
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
  | { data: T }                    // Success: I have data
  | { data: undefined; error: E }; // Failure: no data, but I have error

function handleDataOnly<T, E>(result: ResultDataOnly<T, E>) {
  // Check data (it's present in BOTH variants)
  if (result.data !== undefined) {
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
 * - 'data' is present in BOTH variants (T or undefined)
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
  | { data: T; error: undefined }  // Success: no error, I have data
  | { error: E };                   // Failure: I have error

function handleErrorOnly<T, E>(result: ResultErrorOnly<T, E>) {
  // Check error (it's present in BOTH variants)
  if (result.error !== undefined) {
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
 * - 'error' is present in BOTH variants (E or undefined)
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
 * DataOnly:  'data' is complete (T vs undefined)
 * ErrorOnly: 'error' is complete (undefined vs E)
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
  | { data: T; error: undefined }      // 'data' is complete: T vs undefined
  | { data: undefined; error: E };     // 'error' is complete: undefined vs E
                                       // ↑ BOTH are complete!

/*
 * Wait... now BOTH properties are discriminants!
 * - 'data' can discriminate (T vs undefined)
 * - 'error' can discriminate (undefined vs E)
 *
 * This means we can check EITHER property to narrow the type!
 */

function handleResult<T, E>(result: Result<T, E>) {
  // Option 1: Check error first
  if (result.error !== undefined) {
    const err: E = result.error;     // ✅ error is E
    console.error("Error:", err);
    // result.data is undefined here
    return;
  }

  const value: T = result.data;       // ✅ data is T
  console.log("Success:", value);
  // result.error is undefined here
}

function handleResult2<T, E>(result: Result<T, E>) {
  // Option 2: Check data first (equally valid!)
  if (result.data !== undefined) {
    const value: T = result.data;     // ✅ data is T
    console.log("Success:", value);
    // result.error is undefined here
  } else {
    const err: E = result.error;       // ✅ error is E
    console.error("Error:", err);
    // result.data is undefined here
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
if (result1.data !== undefined) {
  result1.data; // string
} else {
  result1.error; // Error
}

// ErrorOnly: Must check error
if (result2.error !== undefined) {
  result2.error; // Error
} else {
  result2.data; // string
}

// Symmetrical: Can check EITHER!
if (result3.data !== undefined) {
  result3.data; // string
}
if (result3.error !== undefined) {
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
// Why Explicit Undefined Is Required (For Symmetry)
// ============================================================================

/*
 * You might wonder: Can I just omit the undefined property?
 *
 * For single discriminants (DataOnly, ErrorOnly), you technically can:
 */

type ResultDataOnlyOmitted<T, E> =
  | { data: T }
  | { error: E };

// For single discriminants, you can omit and use 'in' operator:
function handleOmitted<T, E>(result: ResultDataOnlyOmitted<T, E>) {
  if ("data" in result) {
    // ✅ With only ONE discriminant, 'in' works!
    // result.data is T here
    const value: T = result.data;
  } else {
    // result.error is E here
    const err: E = result.error;
  }
}

/*
 * Why does 'in' work for single discriminants?
 * - 'data' exists in variant 1, doesn't exist in variant 2
 * - TypeScript can use presence/absence to narrow
 * - This is Pattern 2 from discriminated-union-demo.ts
 */

/*
 * But for SYMMETRICAL discriminants, omission completely breaks:
 */

type ResultSymmetricalOmitted<T, E> =
  | { data: T }
  | { error: E };

function handleSymmetricalOmitted<T, E>(result: ResultSymmetricalOmitted<T, E>) {
  // 🚨 The 'in' operator doesn't narrow properly!
  if ("data" in result) {
    // result.data is T | undefined (not T!)
    // const value: T = result.data; // ❌ Type error
  }

  if ("error" in result) {
    // result.error is E | undefined (not E!)
    // const err: E = result.error; // ❌ Type error
  }

  // 🚨 Even checking values doesn't help with omission!
  if (result.data !== undefined) {
    // result.data is STILL T | undefined (not T!)
    // const value: T = result.data; // ❌ Type error
  }
}

/*
 * Why doesn't 'in' work for symmetrical discriminants?
 * - With omission, nothing prevents: { data: T, error: E } at runtime
 * - TypeScript must assume BOTH properties might exist
 * - So it types them conservatively: T | undefined and E | undefined
 * - The 'in' check can't narrow because mutual exclusivity isn't enforced
 *
 * This is why checking "data" in result vs result.data !== undefined
 * are NOT interchangeable for symmetrical patterns!
 */

/*
 * Why? Because nothing prevents this at runtime:
 */

const ambiguous: ResultSymmetricalOmitted<string, Error> = {
  data: "success",
  // @ts-expect-error - but nothing stops this at runtime!
  error: new Error("also an error?"),
};

/*
 * TypeScript must assume BOTH properties might exist,
 * so it types them as T | undefined and E | undefined.
 *
 * With explicit undefined:
 */

const enforced: Result<string, Error> = {
  data: "success",
  error: undefined, // Required!
};

// This is a compile error:
// const invalid: Result<string, Error> = {
//   data: "success",
//   error: new Error("can't have both!"), // ❌ Type error!
// };

/*
 * Explicit undefined enforces mutual exclusivity at compile time,
 * which allows TypeScript to narrow correctly.
 *
 * The key insight: A discriminant must be present in ALL variants!
 * - With explicit undefined: Both properties are present everywhere → both discriminate
 * - With omission: Properties are absent in some variants → can't discriminate symmetrically
 *
 * The takeaway:
 * - Single discriminants (Pattern 2): Omission can work with 'in' operator
 * - Symmetrical discriminants (Pattern 3): MUST use explicit undefined
 * - "prop" in obj vs obj.prop !== undefined: NOT the same for symmetrical patterns!
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
