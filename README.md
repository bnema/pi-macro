# pi-macro

Create and reuse prompt macros inside Pi.

## What it does

- Stores named prompt templates locally.
- Expands variables such as `{{input}}` and `{{args}}`.
- Shows previews before sending when needed.
- Sends the resolved macro as a normal user message.
- Adds a searchable picker in interactive Pi sessions.

## Install

```bash
pi install git:github.com/bnema/pi-macro
```

## Slash commands

```text
/macro
/macro <name> [input...]
/macro-list [query]
/macro-new [name]
/macro-edit <name>
/macro-delete <name>
/macro-show <name> [input...]
/macro-find [query]
/macro-duplicate <source> [target]
```

If `/macro <name>` cannot find a macro, interactive modes offer to create it. Non-interactive modes fail with `Macro not found`.

## Picker and modes

Interactive Pi sessions get a searchable picker with preview, create, edit, delete, duplicate, and send actions. Print, JSON, and no-UI modes avoid pickers and fail commands that need missing interactive input.

## Storage and variables

Macros are stored at:

```text
~/.pi/macro/macros.json
```

Useful variables include `{{input}}`, `{{args}}`, quoted arguments, and supported context variables. Sensitive or truncated previews ask for confirmation before sending.

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
