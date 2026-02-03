# Epicenter CLI

Manage workspace data and start the sync server.

## Command Structure

```bash
epicenter table <name> <action>   # table operations
epicenter kv <action>             # key-value operations
epicenter tables                  # list table names
epicenter workspaces              # list workspace names
epicenter serve                   # start HTTP/WebSocket server
```

## Table Commands

```bash
epicenter table users list              # list all rows
epicenter table users list --all        # include invalid rows
epicenter table users get <id>          # get row by id
epicenter table users set '<json>'      # create/replace row
epicenter table users update <id> --name "New"  # partial update
epicenter table users delete <id>       # delete row
epicenter table users clear             # delete all rows
epicenter table users count             # count rows
```

## KV Commands

```bash
epicenter kv get <key>            # get value
epicenter kv set <key> <value>    # set value
epicenter kv delete <key>         # delete key
```

## Multi-Workspace Mode

With multiple workspaces, prefix commands with the workspace name:

```bash
epicenter blog table posts list
epicenter blog kv get theme
epicenter shop table products get abc123
```

## Input Methods

```bash
# Inline JSON
epicenter table users set '{"id":"1","name":"Alice"}'

# From file
epicenter table users set --file user.json
epicenter table users set @user.json

# From stdin
cat user.json | epicenter table users set

# Flag-based update
epicenter table users update abc123 --name "Bob" --active true
```

## Output Formats

```bash
epicenter table users list                  # pretty JSON (TTY)
epicenter table users list | jq             # compact JSON (pipe)
epicenter table users list --format json    # force JSON
epicenter table users list --format jsonl   # JSON lines
```

## Server

```bash
epicenter serve              # default port 3913
epicenter serve --port 8080  # custom port
```

Exposes REST API and WebSocket sync for all workspaces.

## Reserved Names

Table names have no restrictions.

Workspace names cannot be: `table`, `tables`, `kv`, `workspaces`, `serve`, `help`, `version`.
