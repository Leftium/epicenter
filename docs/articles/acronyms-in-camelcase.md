# Acronyms in camelCase: Treat Them as Words

When writing identifiers in camelCase or PascalCase, treat acronyms as single words with only the first letter capitalized.

## The Rule

```typescript
// Correct - treat acronym as a word
parseUrl()
defineKv()
readJson()
customerId
httpClient
xmlParser

// Incorrect - all-caps acronyms
parseURL()
defineKV()
readJSON()
customerID
HTTPClient
XMLParser
```

## Why This Matters

### 1. Adjacent Acronyms Become Unreadable

When two acronyms appear next to each other with all-caps, you can't tell where one ends and the next begins:

```typescript
// What does this mean?
RMIIIOPServerImpl  // RMI + IIOP? RMII + IOP?

// Clear word boundaries
RmiIiopServerImpl
```

### 2. Lowercase camelCase Breaks

If you have a PascalCase class with an acronym, the variable name becomes awkward:

```typescript
// PascalCase class
class URLParser {}

// Variable... uRLParser? Ugly.
const uRLParser = new URLParser();

// With title-cased acronyms
class UrlParser {}
const urlParser = new UrlParser();  // Clean
```

### 3. Inconsistent Application

Real-world codebases end up with inconsistencies when trying to preserve acronyms:

```typescript
// Java's actual API - why is HTTP lowercase but URL uppercase?
HttpURLConnection

// Consistent title-case would be
HttpUrlConnection
```

### 4. The Fundamental Principle

**camelCase does not preserve original casing.** That's the whole point of the convention: it transforms words into a single identifier with word boundaries marked by capitalization. Expecting acronyms to be special exceptions breaks this principle.

## What Style Guides Say

### Google TypeScript Style Guide

> "Treat abbreviations like acronyms in names as whole words, i.e. use `loadHttpUrl`, not `loadHTTPURL`, unless required by a platform name (e.g. `XMLHttpRequest`)."

The only exception is matching existing platform APIs.

### TypeScript-ESLint

The `strictCamelCase` format rule disallows consecutive capitals. `myId` is valid, but `myID` is not.

## When to Match Platform APIs

The one exception: when matching an existing API name that you don't control.

```typescript
// XMLHttpRequest is a browser API - match it
const xhr = new XMLHttpRequest();

// But your own code should use title-case
function createXmlRequest() { ... }
```

## Summary

| Pattern | Example | Status |
|---------|---------|--------|
| Title-case acronyms | `parseUrl`, `defineKv`, `customerId` | Correct |
| All-caps acronyms | `parseURL`, `defineKV`, `customerID` | Avoid |
| Matching platform API | `XMLHttpRequest` | Exception |

## References

- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) - Official recommendation
- [A rant about how to properly camel-case acronyms](https://gist.github.com/adashrod/66564c690906c9b774e77ddacbd06e1b) - Comprehensive argument with examples
- [MDN Glossary: Camel case](https://developer.mozilla.org/en-US/docs/Glossary/Camel_case) - Notes on the inconsistency
