# command-handoff

Provide `request_command_handoff` to ask the user to run a shell command, then resume the task after its result is recorded. The tool does not execute commands or interpret errors.

The companion [permission-handoff skill](../../skills/permission-handoff/SKILL.md) guides the model to use it for permission errors. There is no automatic permission-error hook; skill selection and the decision to call the tool are model-driven.

## Entry point

- `./main.ts`

## Tool

`request_command_handoff` takes one required argument:

```json
{
  "command": "ps aux | grep '[v]ite'"
}
```

Pass the command without a leading `!`. Call the tool alone, not alongside other tools. It is model-only on Pi versions supporting tool exposure and requests sequential execution. It never grants permissions or overrides a user refusal or security policy.

## Setup

Commands use Pi's normal `!` execution path. This extension does not change user-shell settings or bypass other extensions' `user_bash` handlers.

## Behavior

Calling `request_command_handoff` in the interactive TUI opens a Yes/No confirmation for the supplied command, regardless of why the model requested handoff.

- **Yes:** stop the agent and put the original command, unchanged except for a leading `!`, into the message input. Review/edit it, then press Enter to execute it yourself. Nothing is executed automatically.
- After you execute the handed-off command unchanged, the agent automatically continues once its result is recorded, whether the command succeeds or fails. No extra "continue" message is needed. Ordinary `!` commands are unaffected.
- **No / Esc:** leave the input and agent operation unchanged.
- The confirmation shows a muted heading and the command in bold accent text, without explanatory or warning messages. An existing input draft is replaced only after confirmation.
- Concurrent requests are offered one at a time. Accepting one stops further handoffs for that operation.
- If messages are queued, handoff is skipped with an explanation in the tool result to avoid losing them when Pi restores them into the editor on abort. If the input or queue changes during confirmation, handoff is also skipped rather than overwriting the new content.
- Auto-resume is cancelled if the command is edited, the execution is cancelled, `!!` is used, another command is submitted, a different shell result is recorded, a new draft or queued message appears, or you submit another prompt or switch sessions/branches. In those cases, continue manually if needed. Outer command whitespace is ignored when matching, as in Pi.
- RPC, JSON, and print modes reject tool calls with an interactive-TUI-required error.

## Limits

Pi has no public user-shell completion event, so this extension checks in-memory history every 250 ms only while a handoff is pending. It matches the next shell result by command, session, and branch. While waiting, it also observes the configured submit key to cancel on an edited or second submission without consuming that key. It does not intercept execution or change other extensions' shell handlers. Because results have no execution correlation ID, clearing the staged command and later running the exact same command without another detected action can still resume the agent. Edits made and reverted between checks cannot be detected. Pending handoffs are not restored after reload.

A failed command may already have completed earlier steps. Executing the whole command again can repeat their side effects; review it before submitting. Stopping the agent cannot undo work already performed by other tools running in parallel.
