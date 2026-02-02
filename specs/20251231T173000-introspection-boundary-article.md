# Spec: The Introspection Boundary Article

Write a technical article about the trade-offs between static objects and functions for API design, focusing on introspection.

## Background

In the Epicenter codebase (specifically `packages/epicenter`), there's a recurring pattern where workspace actions are defined using a factory function: `actions: ({ tables, providers }) => ({ ... })`. While this provides great flexibility and dependency injection, it makes "introspection" (discovering what actions exist without running the system) difficult.

## Objectives

- Explain what introspection is and why it matters.
- Compare static objects vs. callback functions for API definitions.
- Provide concrete examples from Epicenter-like architectures and Standard Schema.
- Offer practical guidance on where to draw the "introspection boundary".

## Proposed Content Structure

1. **TL;DR**: Quick summary of the core advice (metadata static, execution dynamic).
2. **Introduction**: The "Restaurant Menu" analogy.
3. **What is Introspection?**: Define it in terms of CLI help, IDE autocomplete, and MCP registration.
4. **The Tension**: Why we love functions (composability) and why they fail at discovery.
5. **Case Study 1: The Epicenter Workspace**:
   - Show the `actions: (context) => ({ ... })` pattern.
   - Explain why listing actions requires full system initialization.
   - Show the better alternative: static metadata + dynamic handlers.
6. **Case Study 2: Standard Schema**:
   - Explain the `~standard` property.
   - How it uses static version/vendor info but dynamic validation.
7. **Case Study 3: CLI Help**:
   - The problem of connecting to a DB just to print `--help`.
8. **Trade-offs Table**: Comparison of approaches.
9. **The Golden Rule**: Metadata static, execution dynamic.
10. **Conclusion**: When to use each approach.

## Tasks

- [x] Research specific Epicenter action definitions for realistic examples
- [x] Draft the article content in `docs/articles/introspection-boundary.md`
- [x] Verify technical accuracy of code examples
- [x] Review for tone and clarity (following the "strong opinionated" technical writer style)

## Review

The article "The Introspection Boundary: Where Functions Kill Discoverability" has been written and saved to `docs/articles/introspection-boundary.md`.

### Key highlights:

- Word count: 1887 words (fits the 1500-2000 target).
- Style: Direct, factual, and opinionated, following the repository's established technical writing style.
- Content: Covers introspection definition, the fundamental tension, 3 concrete examples (Epicenter workspaces, Standard Schema, CLI help), and the "Golden Rule".
- Punctuation: Adheres to the punctuation guidelines (avoiding AI artifacts like " - ").
- Examples: Use the requested "❌" and "✅" pattern with technically accurate Epicenter-inspired code.
