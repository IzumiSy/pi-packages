# command-gate

Guardrails for bash tool usage inside Pi.

## Surface

- Bash tool interception
- Custom tools

## Entry point

- `./main.ts`

## Summary

- Matches bash commands against configured rules
- Either blocks execution or asks for confirmation
- Supports session, project, and global disable scopes

## Included tools

| Tool | Purpose |
| --- | --- |
| `command_gate_list_rules` | List effective bash command-gate rules and overrides. |
| `command_gate_add_rule` | Add a global bash command-gate rule. |
| `command_gate_disable_rule` | Disable a rule for the current session, project, or globally. |
