import { resolve } from "node:path";
import {
  loadSkillsFromDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import commandHandoff from "../extensions/command-handoff/main.ts";

type BashMessage = Extract<
  Parameters<SessionManager["appendMessage"]>[0],
  { role: "bashExecution" }
>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function mount() {
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  let tool!: ToolDefinition & { exposure?: string };
  const api = {
    on: vi.fn((name: string, callback: (event: never, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, callback);
    }),
    registerTool: vi.fn((definition: typeof tool) => {
      tool = definition;
    }),
    sendMessage: vi.fn(),
  };
  const controller = new AbortController();
  let editor = "";
  let terminalInput: Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0] | undefined;
  const unsubscribe = vi.fn(() => {
    terminalInput = undefined;
  });
  const ui = {
    theme: {
      fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
      bold: vi.fn((text: string) => `<bold>${text}</bold>`),
    },
    onTerminalInput: vi.fn((handler: NonNullable<typeof terminalInput>) => {
      terminalInput = handler;
      return unsubscribe;
    }),
    confirm: vi.fn<ExtensionContext["ui"]["confirm"]>().mockResolvedValue(true),
    getEditorText: vi.fn(() => editor),
    setEditorText: vi.fn((text: string) => {
      editor = text;
    }),
    notify: vi.fn(),
  };
  const ctx = {
    mode: "tui",
    signal: controller.signal,
    sessionManager: SessionManager.inMemory(),
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    abort: vi.fn(() => controller.abort()),
    ui,
  };
  commandHandoff(api as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event as never, ctx as unknown as ExtensionContext);
  return {
    api,
    tool,
    ctx,
    controller,
    ui,
    emit,
    unsubscribe,
    terminalInput: (data: string) => terminalInput?.(data),
    submitShell: (text = editor) => {
      editor = text;
      const result = terminalInput?.("\r");
      editor = "";
      return result;
    },
    editor: () => editor,
    recordShell: (overrides: Partial<BashMessage> = {}) => {
      editor = "";
      return ctx.sessionManager.appendMessage({
        role: "bashExecution",
        command: "touch /restricted/file",
        output: "shell output",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: Date.now(),
        ...overrides,
      });
    },
    result: (command: unknown = "touch /restricted/file", signal = controller.signal) =>
      tool.execute(
        "call-1",
        { command },
        signal,
        undefined,
        ctx as unknown as Parameters<typeof tool.execute>[4],
      ),
  };
}

describe("command-handoff", () => {
  it("registers a sequential, model-only tool with only a command argument", () => {
    const app = mount();
    expect(app.api.registerTool).toHaveBeenCalledOnce();
    expect(app.tool).toMatchObject({
      name: "request_command_handoff",
      exposure: "model-only",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: { command: { type: "string", minLength: 1 } },
        required: ["command"],
        additionalProperties: false,
      },
    });
    expect(app.tool.parameters).toHaveProperty("properties", {
      command: expect.objectContaining({ type: "string", minLength: 1 }),
    });
    expect(app.api.on.mock.calls.map(([name]) => name)).not.toContain("tool_result");
  });

  it("loads the companion permission-handoff skill for automatic model selection", () => {
    const result = loadSkillsFromDir({
      dir: resolve("skills/permission-handoff"),
      source: "test",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "permission-handoff",
        description: expect.stringContaining("request_command_handoff"),
        disableModelInvocation: false,
      }),
    ]);
  });

  it("highlights only the command and stages it unchanged without running it", async () => {
    const app = mount();
    const command = "  printf '%s\\n' 'hello world' &&\n  touch /restricted/file  ";
    await expect(app.result(command)).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Nothing has been executed") }],
      terminate: true,
    });
    expect(app.ui.confirm).toHaveBeenCalledWith(
      "<muted>Hand off to your shell?</muted>",
      `\n<accent><bold>${command}</bold></accent>\n`,
      { signal: app.controller.signal },
    );
    expect(app.ctx.abort).toHaveBeenCalledOnce();
    expect(app.editor()).toBe(`!${command}`);
  });

  it("does not react to permission errors unless the tool is called", async () => {
    const app = mount();
    app.emit("tool_result", {
      toolName: "bash",
      input: { command: "touch /restricted/file" },
      content: [{ type: "text", text: "Operation not permitted" }],
      isError: true,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(app.ui.confirm).not.toHaveBeenCalled();
    expect(app.ctx.abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, undefined])(
    "leaves input and agent unchanged on No/cancel (%s)",
    async (answer) => {
      const app = mount();
      app.ui.setEditorText("my draft");
      app.ui.setEditorText.mockClear();
      app.ui.confirm.mockResolvedValueOnce(answer as boolean);
      const result = await app.result();
      expect(result).not.toHaveProperty("terminate");
      expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("declined") }]);
      expect(app.ui.setEditorText).not.toHaveBeenCalled();
      expect(app.ctx.abort).not.toHaveBeenCalled();
      expect(app.editor()).toBe("my draft");
    },
  );

  it("replaces an existing draft after confirmation without extra warnings", async () => {
    const app = mount();
    app.ui.setEditorText("my draft");
    await app.result();
    expect(app.ui.confirm.mock.calls[0]?.[1]).toBe(
      "\n<accent><bold>touch /restricted/file</bold></accent>\n",
    );
    expect(app.editor()).toBe("!touch /restricted/file");
  });

  it.each([null, 123, "", " \n"])("rejects an invalid command: %j", async (command) => {
    const app = mount();
    await expect(app.result(command)).rejects.toThrow("command must be a non-empty string");
    expect(app.ui.confirm).not.toHaveBeenCalled();
    expect(app.ui.setEditorText).not.toHaveBeenCalled();
    expect(app.ctx.abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rpc", "json", "print"])("rejects handoff in %s mode", async (mode) => {
    const app = mount();
    app.ctx.mode = mode;
    await expect(app.result()).rejects.toThrow("requires the interactive TUI");
    expect(app.ui.confirm).not.toHaveBeenCalled();
    expect(app.ctx.abort).not.toHaveBeenCalled();
  });

  it("does not discard queued messages when abort would restore them into the editor", async () => {
    const app = mount();
    app.ctx.hasPendingMessages.mockReturnValue(true);
    const result = await app.result();
    expect(result).not.toHaveProperty("terminate");
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("queued messages") },
    ]);
    expect(app.ui.confirm).not.toHaveBeenCalled();
    expect(app.ctx.abort).not.toHaveBeenCalled();
    expect(app.ui.setEditorText).not.toHaveBeenCalled();
  });

  it.each(["draft", "queue"])("preserves a %s changed during confirmation", async (change) => {
    const app = mount();
    app.ui.confirm.mockImplementationOnce(async () => {
      if (change === "draft") app.ui.setEditorText("new draft");
      else app.ctx.hasPendingMessages.mockReturnValue(true);
      app.ui.setEditorText.mockClear();
      return true;
    });
    const result = await app.result();
    expect(result).not.toHaveProperty("terminate");
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("changed during confirmation") },
    ]);
    expect(app.ctx.abort).not.toHaveBeenCalled();
    expect(app.ui.setEditorText).not.toHaveBeenCalled();
    if (change === "draft") expect(app.editor()).toBe("new draft");
  });

  it("does not prompt after the operation has been aborted", async () => {
    const app = mount();
    app.controller.abort();
    await app.result();
    expect(app.ui.confirm).not.toHaveBeenCalled();
  });

  it("does not stage a command if the operation is aborted during confirmation", async () => {
    const app = mount();
    app.ui.confirm.mockImplementationOnce(async () => {
      app.controller.abort();
      return true;
    });
    await app.result();
    expect(app.ui.setEditorText).not.toHaveBeenCalled();
    expect(app.ctx.abort).not.toHaveBeenCalled();
  });

  it("uses the execute signal rather than an unrelated active context signal", async () => {
    const app = mount();
    const operation = new AbortController();
    operation.abort();
    const result = await app.result("touch /restricted/file", operation.signal);
    expect(result.content).toEqual([{ type: "text", text: "Command handoff cancelled." }]);
    expect(app.ui.confirm).not.toHaveBeenCalled();
    expect(app.controller.signal.aborted).toBe(false);
  });

  it("honors execute-signal cancellation during confirmation", async () => {
    const app = mount();
    const operation = new AbortController();
    app.ui.confirm.mockImplementationOnce(async () => {
      operation.abort();
      return true;
    });
    const result = await app.result("touch /restricted/file", operation.signal);
    expect(app.ui.confirm).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      signal: operation.signal,
    });
    expect(result).not.toHaveProperty("terminate");
    expect(app.ui.setEditorText).not.toHaveBeenCalled();
    expect(app.ctx.abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a queued request bound to its captured operation signal", async () => {
    const app = mount();
    const operation = new AbortController();
    let answer!: (value: boolean) => void;
    app.ui.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const first = app.result();
    const second = app.result("second command", operation.signal);
    await Promise.resolve();
    operation.abort();
    app.ctx.signal = new AbortController().signal;
    answer(false);
    const [, result] = await Promise.all([first, second]);
    expect(result.content).toEqual([{ type: "text", text: "Command handoff cancelled." }]);
    expect(app.ui.confirm).toHaveBeenCalledOnce();
    expect(app.ui.setEditorText).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes concurrent requests and keeps the first accepted command", async () => {
    const app = mount();
    let answer!: (value: boolean) => void;
    app.ui.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const first = app.result();
    const second = app.result("second command");
    await Promise.resolve();
    expect(app.ui.confirm).toHaveBeenCalledOnce();
    answer(true);
    await Promise.all([first, second]);
    expect(app.ui.confirm).toHaveBeenCalledOnce();
    expect(app.editor()).toBe("!touch /restricted/file");
  });

  it("offers the next concurrent request after No", async () => {
    const app = mount();
    app.ui.confirm.mockResolvedValueOnce(false);
    await Promise.all([app.result(), app.result("second command")]);
    expect(app.ui.confirm).toHaveBeenCalledTimes(2);
    expect(app.editor()).toBe("!second command");
  });

  it("reports UI errors without preventing future handoff attempts", async () => {
    const app = mount();
    app.ui.confirm.mockRejectedValueOnce(new Error("dialog failed"));
    await expect(app.result()).rejects.toThrow("dialog failed");
    expect(app.ctx.abort).not.toHaveBeenCalled();
    await app.result();
    expect(app.editor()).toBe("!touch /restricted/file");
  });

  it.each([0, 1])(
    "resumes once after a recorded shell result with exit code %s",
    async (exitCode) => {
      const app = mount();
      await app.result();
      expect(app.controller.signal.aborted).toBe(true);
      expect(app.submitShell()).toBeUndefined();
      app.recordShell({ exitCode });
      await vi.advanceTimersByTimeAsync(250);
      expect(app.api.sendMessage).toHaveBeenCalledExactlyOnceWith(
        {
          customType: "command-handoff-resume",
          content: expect.stringContaining("using its recorded result"),
          display: false,
        },
        { triggerTurn: true },
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(app.unsubscribe).toHaveBeenCalledOnce();
      app.recordShell();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(app.api.sendMessage).toHaveBeenCalledOnce();
    },
  );

  it("waits for a new recorded result and does not repeatedly scan unchanged history", async () => {
    const app = mount();
    app.recordShell();
    await app.result();
    const getBranch = vi.spyOn(app.ctx.sessionManager, "getBranch");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(app.api.sendMessage).not.toHaveBeenCalled();
    expect(getBranch).not.toHaveBeenCalled();
    app.recordShell();
    await vi.advanceTimersByTimeAsync(250);
    expect(getBranch).toHaveBeenCalledOnce();
    expect(app.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("matches Pi's outer whitespace trimming without changing the staged command", async () => {
    const app = mount();
    const command = "  printf '%s\\n' 'hello world' &&\n  touch /restricted/file  ";
    await app.result(command);
    expect(app.editor()).toBe(`!${command}`);
    expect(app.submitShell()).toBeUndefined();
    app.recordShell({ command: command.trim() });
    await vi.advanceTimersByTimeAsync(250);
    expect(app.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps watching through the original abort and waits for the agent to become idle", async () => {
    const app = mount();
    await app.result();
    app.ctx.isIdle.mockReturnValue(false);
    app.ctx.sessionManager.appendCustomEntry("original-run-ending", {});
    app.emit("agent_end");
    app.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(250);
    app.recordShell();
    await vi.advanceTimersByTimeAsync(500);
    expect(app.api.sendMessage).not.toHaveBeenCalled();
    app.ctx.isIdle.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(app.api.sendMessage).toHaveBeenCalledOnce();
  });

  it.each([{ command: "another command" }, { cancelled: true }, { excludeFromContext: true }])(
    "disarms on an unrelated, cancelled, or private shell result: %j",
    async (result) => {
      const app = mount();
      await app.result();
      app.recordShell(result);
      await vi.advanceTimersByTimeAsync(250);
      expect(vi.getTimerCount()).toBe(0);
      app.recordShell();
      await vi.advanceTimersByTimeAsync(250);
      expect(app.api.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["!another command", "!touch /restricted/file", "!!touch /restricted/file"])(
    "disarms on a second submission before that command finishes: %s",
    async (text) => {
      const app = mount();
      await app.result();
      app.submitShell();
      app.recordShell();
      expect(app.submitShell(text)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      expect(app.api.sendMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(app.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it.each(["!edited command", "!!touch /restricted/file"])(
    "disarms on an edited submission even between polling ticks: %s",
    async (text) => {
      const app = mount();
      await app.result();
      expect(app.submitShell(text)).toBeUndefined();
      app.recordShell();
      await vi.advanceTimersByTimeAsync(250);
      expect(app.api.sendMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["confirmation", "command"])("ignores the %s Enter key release", async (phase) => {
    const app = mount();
    await app.result();
    if (phase === "confirmation") app.terminalInput("\u001b[13;1:3u");
    expect(app.terminalInput("\u001b[13;1u")).toBeUndefined();
    app.ui.setEditorText("");
    if (phase === "command") app.terminalInput("\u001b[13;1:3u");
    app.recordShell();
    await vi.advanceTimersByTimeAsync(250);
    expect(app.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("leaves non-submit keys alone", async () => {
    const app = mount();
    await app.result();
    expect(app.terminalInput("\u001b[A")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    app.submitShell();
    app.recordShell();
    await vi.advanceTimersByTimeAsync(250);
    expect(app.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("does not resume if another shell result follows before polling", async () => {
    const app = mount();
    await app.result();
    app.recordShell();
    app.recordShell({ command: "another command" });
    await vi.advanceTimersByTimeAsync(250);
    expect(app.api.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["edited command", "new draft", "queued message"])(
    "preserves %s and cancels auto-resume",
    async (change) => {
      const app = mount();
      await app.result();
      if (change !== "edited command") app.recordShell();
      if (change === "queued message") app.ctx.hasPendingMessages.mockReturnValue(true);
      else app.ui.setEditorText(change === "edited command" ? "!edited command" : "new draft");
      app.ui.setEditorText.mockClear();
      const draft = app.editor();
      await vi.advanceTimersByTimeAsync(250);
      expect(app.ui.setEditorText).not.toHaveBeenCalled();
      expect(app.editor()).toBe(draft);
      expect(vi.getTimerCount()).toBe(0);
      app.ctx.hasPendingMessages.mockReturnValue(false);
      app.recordShell();
      await vi.advanceTimersByTimeAsync(250);
      expect(app.api.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    "input",
    "before_agent_start",
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "session_start",
    "session_shutdown",
  ])("stops watching on %s", async (event) => {
    const app = mount();
    await app.result();
    expect(vi.getTimerCount()).toBe(1);
    app.emit(event);
    app.recordShell();
    const getLeaf = vi.spyOn(app.ctx.sessionManager, "getLeafId");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(getLeaf).not.toHaveBeenCalled();
    expect(app.unsubscribe).toHaveBeenCalledOnce();
    expect(app.api.sendMessage).not.toHaveBeenCalled();
  });

  it("does not resume in another session even if the switch event is missed", async () => {
    const app = mount();
    await app.result();
    app.ctx.sessionManager.newSession();
    app.recordShell();
    await vi.advanceTimersByTimeAsync(250);
    expect(app.api.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resume on another branch even if the navigation event is missed", async () => {
    const app = mount();
    const root = app.ctx.sessionManager.appendCustomEntry("root", {});
    app.ctx.sessionManager.appendCustomEntry("original-branch", {});
    await app.result();
    app.ctx.sessionManager.branch(root);
    app.recordShell();
    await vi.advanceTimersByTimeAsync(250);
    expect(app.api.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["ordinary shell", "declined", "aborted", "queued", "UI failure"])(
    "never watches without an accepted handoff: %s",
    async (scenario) => {
      const app = mount();
      if (scenario === "declined") app.ui.confirm.mockResolvedValueOnce(false);
      if (scenario === "aborted") app.controller.abort();
      if (scenario === "queued") app.ctx.hasPendingMessages.mockReturnValue(true);
      if (scenario === "UI failure")
        app.ui.confirm.mockRejectedValueOnce(new Error("dialog failed"));
      if (scenario !== "ordinary shell") {
        if (scenario === "UI failure") await expect(app.result()).rejects.toThrow("dialog failed");
        else await app.result();
      }
      app.recordShell();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(app.api.sendMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
