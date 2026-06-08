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

Override the path with:

```bash
PI_MACRO_FILE=/custom/path/macros.json
```

Directory and file permissions are private where supported (`0700` directory, `0600` file). Writes are atomic and conflict-aware.

Variables use double braces with no whitespace:

```text
{{variable}}
{{ask:question}}
{{choice:label|option1|option2}}
{{confirm:question}}
```

Supported variables:

- Input: `{{input}}`, `{{args}}`
- Interactive: `{{ask:question}}`, `{{choice:label|option1|option2}}`, `{{confirm:question}}`
- Project/time: `{{cwd}}`, `{{project}}`, `{{date}}`, `{{datetime}}`
- Git: `{{git_branch}}`, `{{git_status}}`, `{{git_diff}}`
- Editor/diagnostics: `{{current_file}}`, `{{current_file_path}}`, `{{editor}}`, `{{diagnostics}}`
- Conversation: `{{last_user_message}}`, `{{last_assistant_message}}`, `{{last_message}}`, `{{last_code_block}}`
- Session: `{{session_name}}`, `{{model}}`

Unknown variables, malformed braces, and whitespace such as `{{ input }}` block sending. Escape literal variable text with `\{{input}}`. Sensitive variables, interactive variables, repository variables, and truncated previews require confirmation before sending.

Limits: preview values are capped, total expanded sends are capped, and send-limit violations block delivery.

## Safety exclusions

`pi-macro` intentionally does not support arbitrary shell, environment, file, or clipboard expansion:

- `{{shell:...}}`
- `{{env:...}}`
- `{{file:...}}`
- `{{clipboard}}`

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
