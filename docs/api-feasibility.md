# API feasibility notes

Date: 2026-06-07

## Command and send APIs

- `pi.registerCommand(name, options)` is available. Command handlers receive `(args: string, ctx)`, where `args` is the raw command argument string.
- `ctx.isIdle()` is available and should be used before sending.
- `pi.sendUserMessage(text)` sends a plain user turn when Pi is idle.
- `pi.sendUserMessage(text, { deliverAs: "followUp" })` queues a follow-up while the agent is streaming.
- Shared command logic must receive an injected `SendUserMessage` adapter from `extensions/index.ts`; it must not assume normal command contexts expose `ctx.sendUserMessage()`.

## UI APIs and mode behavior

- `ctx.ui.custom()` supports custom TUI components and overlays. The macro picker should only run in `ctx.mode === "tui"`.
- `ctx.ui.input()`, `ctx.ui.editor()`, `ctx.ui.select()`, and `ctx.ui.confirm()` are available for interactive flows when `ctx.hasUI` is true.
- `ctx.mode` distinguishes `"tui"`, `"rpc"`, `"json"`, and `"print"`.
- `ctx.hasUI` is true for TUI/RPC and false for print/JSON. Print/JSON flows must not open pickers or prompts and should fail clearly when required information is missing.

## Context APIs

- `ctx.cwd` is available.
- `ctx.ui.getEditorText()` is available for `{{editor}}` when UI/editor context exists.
- `ctx.sessionManager.getEntries()` is available for conversation-derived variables.
- Session metadata is available through session-manager helpers such as session name/header/branch where present.
- `ctx.model` is available for model metadata.
- No direct extension API was confirmed for current file path or diagnostics. Implement `{{current_file}}`, `{{current_file_path}}`, and `{{diagnostics}}` as clear unavailable markers unless a later API is discovered.

## Verification

- `rtk npm run typecheck` was attempted during Phase 0. It failed only because the repository initially had no `extensions/**/*.ts` or `src/**/*.ts` inputs. Phase 1 should add the entrypoint and source files before typecheck is expected to pass.
- `pi -e /home/brice/dev/projects/pi-macro` runtime loading is deferred until Phase 1 because Phase 0 starts from a minimal repository with no `extensions/index.ts` entrypoint to load. Phase 1 must add the extension entrypoint, then run the local `pi -e` verification against the actual checkout path.

## Primary references checked

- Pi extension docs: `/home/brice/.local/share/nvm/v25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi TUI docs: `/home/brice/.local/share/nvm/v25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- Send example: `/home/brice/.local/share/nvm/v25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/send-user-message.ts`
- Extension type declarations under the installed Pi package, especially `dist/core/extensions/types.d.ts`.
