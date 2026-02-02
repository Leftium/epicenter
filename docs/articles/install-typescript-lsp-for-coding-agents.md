# Install TypeScript LSP for Coding Agents

If you're using OpenCode, Claude Code, or other coding agents, install the TypeScript Language Server globally:

```bash
npm install -g typescript-language-server typescript
```

## Why This Matters

Coding agents use LSP (Language Server Protocol) for intelligent code operations like:

- **Rename refactoring** - safely rename symbols across your entire codebase
- **Go to definition** - jump to where a function/type is defined
- **Find references** - find all usages of a symbol
- **Hover info** - get type information and documentation

Without a globally installed language server, these tools fall back to text-based search/replace, which is less accurate and can miss edge cases.

## The Problem

Most projects install TypeScript locally in `node_modules`, but coding agents spawn language servers as global commands. When they run `typescript-language-server`, it needs to be in your system PATH.

You'll know this is happening when you see errors like:

```
Error: Executable not found in $PATH: "typescript-language-server"
```

Or when `lsp_servers` shows:

```
typescript [not installed]
```

## The Fix

```bash
# Install both the language server and TypeScript compiler globally
npm install -g typescript-language-server typescript

# Verify installation
which typescript-language-server
typescript-language-server --version
```

## When It's Especially Useful

The LSP rename feature shines for:

- Renaming types, interfaces, or functions used across many files
- Refactoring that needs to update imports automatically
- Ensuring JSDoc references and comments are updated
- Catching usages in complex generic type parameters

For a simple find/replace, AST-grep or even regex might suffice. But for type-aware refactoring across a TypeScript codebase, LSP rename is the safest option.
