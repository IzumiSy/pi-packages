import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease } from "@earendil-works/pi-tui";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export default function commandHandoff(pi: ExtensionAPI) {
  let pending = Promise.resolve();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let removeInputListener: (() => void) | undefined;

  function stopWatching() {
    clearInterval(pollTimer);
    pollTimer = undefined;
    removeInputListener?.();
    removeInputListener = undefined;
  }

  function watchCommandResult(command: string, ctx: ExtensionContext) {
    stopWatching();
    const sessionId = ctx.sessionManager.getSessionId();
    let cursor = ctx.sessionManager.getLeafId();
    let completed = false;
    let submitted = false;

    // Shell submissions bypass input hooks, and earlier user_bash handlers can hide them.
    removeInputListener = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data) || !getKeybindings().matches(data, "tui.input.submit")) return;
      const text = ctx.ui.getEditorText().trim();
      if (
        submitted ||
        !text.startsWith("!") ||
        text.startsWith("!!") ||
        text.slice(1).trim() !== command.trim()
      ) {
        stopWatching();
        return;
      }
      submitted = true;
    });

    // shortcut: Pi has no user-shell completion event; poll new history entries until it does.
    pollTimer = setInterval(() => {
      const draft = ctx.ui.getEditorText();
      if (
        ctx.sessionManager.getSessionId() !== sessionId ||
        ctx.hasPendingMessages() ||
        (draft !== "" && draft !== `!${command}`)
      ) {
        stopWatching();
        return;
      }

      const leaf = ctx.sessionManager.getLeafId();
      if (leaf !== cursor) {
        const branch = ctx.sessionManager.getBranch();
        const index = cursor === null ? -1 : branch.findIndex((entry) => entry.id === cursor);
        if (cursor !== null && index === -1) {
          stopWatching();
          return;
        }
        for (const entry of branch.slice(index + 1)) {
          if (entry.type !== "message" || entry.message.role !== "bashExecution") continue;
          const result = entry.message;
          if (
            completed ||
            result.command !== command.trim() ||
            result.cancelled ||
            result.excludeFromContext
          ) {
            stopWatching();
            return;
          }
          completed = true;
        }
        cursor = leaf;
      }
      if (!completed || !ctx.isIdle()) return;

      stopWatching();
      pi.sendMessage(
        {
          customType: "command-handoff-resume",
          content:
            "The handed-off shell command has completed. Continue the original task using its recorded result.",
          display: false,
        },
        { triggerTurn: true },
      );
    }, 250);
    pollTimer.unref?.();
  }

  pi.on("input", stopWatching);
  pi.on("before_agent_start", stopWatching);
  pi.on("session_before_switch", stopWatching);
  pi.on("session_before_fork", stopWatching);
  pi.on("session_before_tree", stopWatching);
  pi.on("session_start", stopWatching);
  pi.on("session_shutdown", stopWatching);

  const tool = {
    exposure: "model-only" as const,
    ...defineTool({
      name: "request_command_handoff",
      label: "Command handoff",
      description:
        "Ask the user to run a shell command. Confirms and stages editable ! input in the interactive TUI, then pauses the agent; does not execute the command. Resumes once after the unchanged command's result is recorded. Call this tool alone, not alongside other tools. Do not use it to bypass a user's refusal or security policy.",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            minLength: 1,
            description: "Exact shell command to hand to the user, without a leading ! prefix",
          },
        },
        required: ["command"],
        additionalProperties: false,
      } as any,
      async execute(_toolCallId, { command }: { command: string }, signal, _onUpdate, ctx) {
        if (ctx.mode !== "tui") throw new Error("Command handoff requires the interactive TUI.");
        if (typeof command !== "string" || !command.trim()) {
          throw new Error("command must be a non-empty string.");
        }
        const operationSignal = signal ?? ctx.signal;
        const handoff = pending.then(async () => {
          if (operationSignal?.aborted) return textResult("Command handoff cancelled.");
          // Pi restores queued messages into the editor on abort; do not overwrite them.
          if (ctx.hasPendingMessages()) {
            return textResult("Command handoff skipped: queued messages would be overwritten.");
          }
          const draft = ctx.ui.getEditorText();
          const confirmed = await ctx.ui.confirm(
            ctx.ui.theme.fg("muted", "Hand off to your shell?"),
            `\n${ctx.ui.theme.fg("accent", ctx.ui.theme.bold(command))}\n`,
            operationSignal ? { signal: operationSignal } : undefined,
          );
          if (operationSignal?.aborted) return textResult("Command handoff cancelled.");
          if (!confirmed) {
            return textResult(
              "Command handoff declined. Do not retry or bypass the user's decision.",
            );
          }
          if (ctx.hasPendingMessages() || ctx.ui.getEditorText() !== draft) {
            return textResult(
              "Command handoff skipped: input or queued messages changed during confirmation.",
            );
          }
          ctx.abort();
          ctx.ui.setEditorText(`!${command}`);
          watchCommandResult(command, ctx);
          return {
            ...textResult(
              "Command handed off to the user. Nothing has been executed; wait for the recorded shell result.",
            ),
            terminate: true,
          };
        });
        pending = handoff.then(
          () => {},
          () => {},
        );
        return handoff;
      },
    }),
  };
  pi.registerTool(tool);
}
