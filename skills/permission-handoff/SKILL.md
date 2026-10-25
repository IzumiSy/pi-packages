---
name: permission-handoff
description: Handle shell commands blocked by Permission denied, Operation not permitted, or an OS-level sandbox restriction. Use when a necessary command cannot run with the agent's permissions and should be handed to the user through request_command_handoff instead of automatically retried.
compatibility: Requires the request_command_handoff tool in Pi's interactive TUI.
---

# Permission Handoff

1. Check that the failure is a permission restriction and that the command is still needed for the user's task. Do not treat an ordinary command failure as a permission error.
2. Respect explicit user refusals, command-gate denials, and security policies. Handoff is not a way to override them or obtain permission that the user has withheld.
3. Do not automatically retry through `sudo`, permission changes, another interpreter, another tool, or an alternate execution path to evade the restriction.
4. If execution in the user's own shell is appropriate, call `request_command_handoff` with the original command as `command`, without adding a `!` prefix. Call it alone, not in parallel with other tools. The tool only asks for confirmation and stages editable input; the user decides whether to execute it.
5. A failed command may have completed earlier steps. If repeating it could cause data loss or duplicate irreversible side effects, clarify with the user before requesting handoff.
6. On acceptance, let the tool pause the agent and resume automatically after the unchanged command's result is recorded. Use that result to continue the original task; do not rerun the command just to obtain the same output or send an extra continuation message.
7. If handoff is declined, cancelled, or skipped, do not repeatedly request it or work around the decision. If the tool is unavailable, explain the restriction and ask the user how to proceed.

## Environment note

Handoff uses Pi's normal `!` execution path; it does not grant permissions or disable sandboxing. If pi-sandbox is installed, user-shell sandboxing depends on its `sandboxUserShell` setting. If the user-run command is also blocked, explain the restriction and ask the user how to proceed. Do not change sandbox settings automatically.
