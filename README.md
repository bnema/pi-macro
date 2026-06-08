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

## Use

```text
/macro
/macro <name> [input...]
/macro-list [query]
/macro-new [name]
/macro-edit <name>
/macro-delete <name>
/macro-show <name> [input...]
```

Macros are stored at:

```text
~/.pi/macro/macros.json
```

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
