# Vercel Rebuilt Bash in TypeScript, and It Actually Works

**TL;DR: `just-bash` is a full bash interpreter written in TypeScript: lexer, parser, AST, tree-walking interpreter, virtual filesystem, and 80+ reimplemented Unix commands. No WASM, no shelling out, no child processes. It runs entirely in the JS runtime.**

> Give AI agents a bash shell without giving them your machine.

That's the pitch. But the implementation is what's wild. They didn't build a regex-based line executor or a glorified `eval`. They built a real interpreter with the same architecture you'd find in a programming language textbook.

## The Pipeline

```
  ┌──────────────┐     ┌───────────┐     ┌───────────┐     ┌─────────────┐
  │  bash string  │────>│   Lexer   │────>│  Parser   │────>│     AST     │
  └──────────────┘     └───────────┘     └───────────┘     └──────┬──────┘
                                                                  │
                                                                  v
  ┌──────────────┐     ┌───────────────┐     ┌────────────────────────────┐
  │  ExecResult  │<────│  Interpreter  │<────│  Tree-Walking Execution    │
  │  {stdout,    │     │  (expansion,  │     │  (control flow, builtins,  │
  │   stderr,    │     │   arithmetic, │     │   command dispatch)        │
  │   exitCode}  │     │   conditionals│     └────────────────────────────┘
  └──────────────┘     └───────────────┘
```

Everything happens in memory. The string `for i in 1 2 3; do echo $i; done` goes through the exact same phases a C compiler would: tokenize, parse into a tree, walk the tree to execute.

## The Lexer Knows Bash Is Weird

The lexer (`src/parser/lexer.ts`) tokenizes bash syntax into a typed token stream. This alone is nontrivial because bash has insane lexical rules: heredocs, nested quoting, `$(())` vs `$()`, `>&2` vs `> &2`.

```typescript
export enum TokenType {
  PIPE = "PIPE",             // |
  PIPE_AMP = "PIPE_AMP",    // |&
  AND_AND = "AND_AND",       // &&
  OR_OR = "OR_OR",           // ||
  DLESS = "DLESS",           // <<
  DLESSDASH = "DLESSDASH",   // <<-
  TLESS = "TLESS",           // <<<
  GREATAND = "GREATAND",     // >&
  AND_GREAT = "AND_GREAT",   // &>
  DBRACK_START = "DBRACK_START", // [[
  DPAREN_START = "DPAREN_START", // ((
  // ... 30+ more token types
}
```

Every one of those is a distinct token because bash assigns different semantics to `<<`, `<<-`, and `<<<`. You can't fake this with regexes.

## The Parser Builds a Real AST

The parser (`src/parser/parser.ts`) is a recursive descent parser that produces typed AST nodes. Here's the grammar it implements, straight from the source:

```
script       ::= statement*
statement    ::= pipeline ((&&|'||') pipeline)*  [&]
pipeline     ::= [!] command (| command)*
command      ::= simple_command | compound_command | function_def
simple_cmd   ::= (assignment)* [word] (word)* (redirection)*
compound_cmd ::= if | for | while | until | case | subshell | group | (( | [[
```

The AST types are TypeScript interfaces. A `StatementNode` holds `PipelineNode[]` connected by `&&` and `||` operators. A `PipelineNode` holds `CommandNode[]` connected by pipes. It's a proper tree:

```typescript
export interface ScriptNode extends ASTNode {
  type: "Script";
  statements: StatementNode[];
}

export interface StatementNode extends ASTNode {
  type: "Statement";
  pipelines: PipelineNode[];
  operators: ("&&" | "||" | ";")[];
  background: boolean;
}

export interface PipelineNode extends ASTNode {
  type: "Pipeline";
  commands: CommandNode[];
}
```

When you call `parse('ls -la | grep foo && echo done')`, you get back a tree where the `&&` splits two pipelines, and the first pipeline contains two commands connected by a pipe. The interpreter walks this tree; it never re-reads the source string.

## The Interpreter Walks the Tree

Here's the core execution loop from `src/interpreter/interpreter.ts`:

```typescript
async executeScript(node: ScriptNode): Promise<ExecResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (const statement of node.statements) {
    const result = await this.executeStatement(statement);
    stdout += result.stdout;
    stderr += result.stderr;
    exitCode = result.exitCode;
    this.ctx.state.lastExitCode = exitCode;
    this.ctx.state.env.set("?", String(exitCode));
  }
  // ...
}
```

It iterates over statements, dispatching each to specialized handlers. `if` nodes go to `executeIf`. `for` nodes go to `executeFor`. Simple commands get expanded (variable substitution, brace expansion, glob matching, tilde expansion, command substitution) and then dispatched to the command registry.

The `exec()` method on `Bash` ties it all together: parse the string, create an isolated interpreter state, walk the AST.

```typescript
const executeScript = async (): Promise<BashExecResult> => {
  const ast = parse(normalized);
  const interpreter = new Interpreter(interpreterOptions, execState);
  const result = await interpreter.executeScript(ast);
  return this.logResult(result as BashExecResult);
};
```

Each `exec()` call gets its own state copy. Environment variables, functions, and cwd don't leak between calls. The filesystem does persist, which matches how real subshells work.

## 80+ Commands, All Reimplemented in TypeScript

This is the part that makes you do a double-take. They didn't just build a shell language interpreter. They reimplemented the commands:

```
src/commands/
├── awk/          ← full AWK interpreter with its own parser + executor
├── sed/          ← stream editor with pattern/hold space
├── grep/         ← regex search with -r, -l, -c, -v, -E, etc.
├── jq/           ← JSON query processor
├── sort/         ← multi-key sorting with -k, -t, -n, -r
├── find/         ← directory traversal with predicates
├── tar/          ← archive creation and extraction
├── sqlite3/      ← SQL via sql.js (the one WASM exception)
├── curl/         ← HTTP client with URL allowlists
├── xargs/        ← argument batching
├── diff/         ← file comparison
├── ... and 70+ more
```

AWK alone has its own parser (`awk/parser.ts`), executor (`awk/executor.ts`), and expression evaluator (`awk/expressions.ts`). It supports `BEGIN`/`END` blocks, field splitting, `printf`, `gsub`, and user-defined functions. That's a language inside a language inside TypeScript.

## The Virtual Filesystem

Everything runs against an in-memory VFS. Four implementations:

| Filesystem  | Reads from    | Writes to     | Use case               |
| ----------- | ------------- | ------------- | ---------------------- |
| InMemoryFs  | Memory        | Memory        | Pure sandbox (default) |
| OverlayFs   | Real disk     | Memory        | Read-only exploration  |
| ReadWriteFs | Real disk     | Real disk     | Agent with disk access |
| MountableFs | Mixed mounts  | Mixed mounts  | Composite layouts      |

The `OverlayFs` is copy-on-write: reads come from your actual filesystem, but writes stay in memory and disappear when execution ends. An AI agent can `cat package.json` from your real project but can't `rm -rf /`.

## Why This Matters

The target audience is AI agents that need a bash tool. Instead of giving an LLM actual shell access (where a hallucinated `rm -rf /` is a real risk), you give it `just-bash` where the worst case is wasting some memory.

The execution protection is real: configurable limits on call depth, command count, loop iterations, and parse complexity. You can't infinite-loop your way out of the sandbox.

```typescript
const env = new Bash({
  executionLimits: {
    maxCallDepth: 100,
    maxCommandCount: 10000,
    maxLoopIterations: 10000,
  },
});
```

It's the same idea as a WebAssembly sandbox but without the WASM. Pure TypeScript, running in Node or the browser, with a security model that comes from architectural constraint rather than OS-level isolation. The shell only sees what you put in the virtual filesystem, can only reach URLs you allowlist, and stops executing when it hits your configured limits.

Is it a complete bash replacement? No. It doesn't support 64-bit integers, can't run native binaries, and has spec test failures in edge cases. But for the use case of "give an AI a shell and don't get burned," the architecture is genuinely sound. They built a real interpreter, not a hack.
