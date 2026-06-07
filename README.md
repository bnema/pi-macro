# pi-macro

Reusable prompt macros for Pi. `pi-macro` stores named prompt templates locally, expands variables, shows previews, and sends the final text to the current Pi session as a normal user message.

## Install

```bash
pi install git:github.com/bnema/pi-macro
```

## Slash commands

- `/macro` opens the searchable picker.
- `/macro <name> [input...]` expands and sends a macro. Extra text is available as `{{input}}` and `{{args}}`; quotes are preserved as typed.
- `/macro-list [query]` lists macros and never opens the picker.
- `/macro-new [name]` creates a macro, prompting for missing fields when UI is available.
- `/macro-edit <name>` edits name, description, and body.
- `/macro-delete <name>` deletes after confirmation.
- `/macro-show <name> [input...]` shows the macro definition and resolved preview.
- `/macro-find [query]` opens the picker filtered by query.
- `/macro-duplicate <source> [target]` copies a macro, prompting for a target name if omitted.

If `/macro <name>` cannot find a macro, interactive modes offer to create it. Non-interactive modes fail with `Macro not found`.

When Pi is idle, macros send immediately. When the agent is streaming, `pi-macro` queues the expanded prompt as a follow-up. Sent messages are plain user messages: no macro name, prefix, or metadata is added.

## Modes

- TUI: full picker, dialogs, confirmations, previews, and direct sends.
- RPC/UI-capable modes: use Pi UI prompts where available; otherwise interactive flows return clear errors.
- print, JSON, and no-UI modes: no picker or prompts. Commands that need interaction fail unless all required values are supplied. JSON mode emits structured command output where supported.

## Picker

Open with `/macro` or `/macro-find [query]`. The picker filters as you type, shows macro descriptions, and previews the resolved message for the selected macro.

Keybindings:

- Type: filter macros
- Up/Down: move selection
- PageUp/PageDown: page results
- Enter: send selected macro
- `/`: enter/clear search mode
- Ctrl-U: clear query
- `n`: new macro
- `e`: edit selected macro
- `d`: delete selected macro
- `y`: duplicate selected macro
- `p`: detailed preview
- Esc: close picker

Static safe macros send directly. Macros with interactive variables, sensitive context variables, or truncated previews collect required values and ask for confirmation before sending.

## Storage

Macros are stored globally in JSON:

```text
~/.pi/macro/macros.json
```

For tests or custom installs, override the path:

```bash
PI_MACRO_FILE=/custom/path/macros.json
```

Directory and file permissions are private where supported (`0700` directory, `0600` file). Writes are atomic and conflict-aware to avoid losing changes from another Pi session.

Format:

```json
{
  "version": 1,
  "macros": [
    {
      "name": "review",
      "description": "Critical review prompt.",
      "body": "Relis ta proposition avec un œil critique...",
      "createdAt": "2026-06-07T00:00:00.000Z",
      "updatedAt": "2026-06-07T00:00:00.000Z"
    }
  ]
}
```

Names must match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`. Lookups are case-insensitive; stored casing and order are preserved.

## Variables

Variables use double braces with no whitespace inside:

```text
{{variable}}
{{ask:question}}
{{choice:label|option1|option2|option3}}
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

Unknown variables, malformed braces, and whitespace such as `{{ input }}` block sending. Escape literal variable text with a backslash: `\{{input}}` renders as `{{input}}`. Duplicate interactive expressions are asked once and reused. In `{{choice:label|option1|option2}}`, labels and options cannot contain `|` or `}}`.

Git variables resolve to unavailable markers outside repositories instead of throwing. Direct-command flows require confirmation for repository variables (`git_branch`, `git_status`, `git_diff`), sensitive context variables, interactive variables, and truncated previews because they can include private or unexpectedly large content.

Limits:

- Preview per variable: 12,000 characters or 300 lines
- Total preview: 24,000 characters
- Send per variable: 60,000 characters
- Total expanded message: 120,000 characters

Preview truncation is disclosed and requires confirmation if the full value would be sent. Send-limit violations block delivery.

## Safety exclusions

`pi-macro` does not support arbitrary shell, environment, file, or clipboard expansion. These are intentionally excluded:

- `{{shell:...}}`
- `{{env:...}}`
- `{{file:...}}`
- `{{clipboard}}`

## Examples

### review

```text
Relis ta proposition avec un œil critique. Challenge les hypothèses, les risques cachés, et propose une version plus simple si possible.
```

Run:

```text
/macro review
```

### spec-plan

```text
Rédige une spec puis un plan d'implémentation Markdown pour Obsidian à partir de la dernière proposition validée.

Dernière réponse assistant :
{{last_assistant_message}}
```

Run:

```text
/macro spec-plan
```

### git-review

```text
Fais une review concise des changements actuels.

Branche: {{git_branch}}
Status:
{{git_status}}

Diff:
{{git_diff}}
```

Run:

```text
/macro git-review
```
