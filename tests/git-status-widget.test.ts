import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gitStatusWidget from "../extensions/git-status-widget/main.ts";

type CustomFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type CustomOptions = Parameters<ExtensionContext["ui"]["custom"]>[1];
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
const environment = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => environment.agentDir,
}));

const cleanups: Array<() => Promise<unknown>> = [];
let configPath: string;

beforeEach(() => {
  vi.useFakeTimers();
  environment.agentDir = mkdtempSync(join(tmpdir(), "git-status-widget-"));
  configPath = join(environment.agentDir, "git-status-widget.json");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(environment.agentDir, { recursive: true, force: true });
});

function result(stdout = "", code = 0): ExecResult {
  return { stdout, stderr: "", code, killed: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function mount(stdout = " M src/app.ts\n", mode = "tui") {
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(result(stdout));
  const api = {
    exec,
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, handler);
    },
  };
  let component: Component | undefined;
  let customOptions: CustomOptions;
  let completeCustom: (() => void) | undefined;
  const done = vi.fn(() => completeCustom?.());
  const tui = { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() };
  const ui = {
    theme: { fg: vi.fn((_color: string, text: string) => `\u001b[32m${text}\u001b[39m`) },
    setWidget: vi.fn(),
    notify: vi.fn(),
    custom: vi.fn((factory: CustomFactory, options: CustomOptions) => {
      customOptions = options;
      component = factory(
        tui as unknown as Parameters<CustomFactory>[0],
        ui.theme as unknown as Parameters<CustomFactory>[1],
        {} as Parameters<CustomFactory>[2],
        done,
      ) as Component;
      return new Promise<void>((resolve) => {
        completeCustom = resolve;
      });
    }),
  };
  const ctx = { cwd: "/repo", hasUI: true, mode, ui } as unknown as ExtensionContext;
  gitStatusWidget(api as unknown as ExtensionAPI);
  // Pi constructs a fresh context for each event, not one object reused forever.
  const emit = async (name: string, event: unknown = {}, context = { ...ctx }) => {
    await handlers.get(name)?.(event as never, context);
  };
  cleanups.push(() => emit("session_shutdown"));
  return {
    exec,
    ui,
    tui,
    done,
    emit,
    ctx,
    component: () => component,
    options: () => customOptions,
    lines: (width = Math.floor(tui.terminal.columns * 0.25)) => component?.render(width) ?? [],
    text: (width?: number) =>
      (component?.render(width ?? Math.floor(tui.terminal.columns * 0.25)) ?? [])
        .map(stripTerminalSequences)
        .join("\n"),
  };
}

describe("git-status-widget display", () => {
  it("mounts at startup without awaiting the persistent custom UI or taking input", async () => {
    const app = mount();
    expect(app.exec).not.toHaveBeenCalled();
    await app.emit("session_start");
    expect(app.ui.custom).toHaveBeenCalledOnce();
    expect(app.done).not.toHaveBeenCalled();
    expect(app.options()).toMatchObject({
      overlay: true,
      overlayOptions: {
        nonCapturing: true,
        anchor: "top-right",
        width: "25%",
        maxHeight: "50%",
        margin: { top: 1, right: 1 },
      },
    });
    expect(app.component()?.handleInput).toBeUndefined();
    expect(app.exec).toHaveBeenCalledWith(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain=v1"],
      {
        cwd: "/repo",
        timeout: 5000,
      },
    );
    expect(app.text()).toContain("Git changes (1)");
    expect(app.ui.setWidget).not.toHaveBeenCalled();
    expect(app.ui.notify).not.toHaveBeenCalled();
  });

  it("shows staged, unstaged, deleted, renamed and untracked files but not ignored files", async () => {
    const app = mount(
      "A  new.ts\n M edited.ts\n D gone.ts\nR  old.ts -> renamed.ts\n?? notes.txt\n!! ignored.txt\n",
    );
    await app.emit("session_start");
    expect(app.text()).toContain("Git changes (5)");
    for (const entry of [
      "A  new.ts",
      " M edited.ts",
      " D gone.ts",
      "R  old.ts -> renamed.ts",
      "?? notes.txt",
    ]) {
      expect(app.text()).toContain(entry);
    }
    expect(app.text()).not.toContain("ignored.txt");
    expect(app.ui.theme.fg.mock.calls).toEqual(
      expect.arrayContaining([
        ["success", "A "],
        ["warning", " M"],
        ["error", " D"],
        ["accent", "R "],
        ["accent", "??"],
      ]),
    );
  });

  it("keeps filename tails and terminal-column bounds for long paths, Unicode and ANSI", async () => {
    const app = mount(" M very/long/nested/directory/変更🚀-app.ts\n");
    await app.emit("session_start");
    for (const columns of [80, 120, 240]) {
      app.tui.terminal.columns = columns;
      const width = Math.floor(columns * 0.25);
      for (const line of app.lines()) expect(visibleWidth(line)).toBe(width);
      expect(app.text()).toContain("🚀-app.ts");
      if (columns >= 120) expect(app.text()).toContain("変更🚀-app.ts");
    }
    expect(app.text(24)).toContain("…");
    expect(app.text(24)).not.toContain("very/long");
  });

  it("keeps a clean-working-tree panel visible and rebuilds colors on theme changes", async () => {
    const app = mount("");
    await app.emit("session_start");
    expect(app.text()).toContain("Git changes (0)");
    expect(app.text()).toContain("Working tree clean");
    app.ui.theme.fg.mockImplementation((_color, text) => `\u001b[31m${text}\u001b[39m`);
    app.component()?.invalidate();
    expect(app.lines().join("\n")).toContain("\u001b[31m");
    expect(app.exec).toHaveBeenCalledOnce();
  });

  it.each([10, 20, 40])(
    "preserves the border and overflow count within half of %s rows",
    async (rows) => {
      const app = mount(Array.from({ length: 15 }, (_, index) => ` M file-${index}.ts`).join("\n"));
      app.tui.terminal.rows = rows;
      await app.emit("session_start");
      const lines = app.lines().map(stripTerminalSequences);
      expect(lines.length).toBeLessThanOrEqual(Math.floor(rows / 2));
      expect(lines[0]).toMatch(/^╭─+╮$/);
      expect(lines.at(-1)).toMatch(/^╰─+╯$/);
      const shown = lines.filter((line) => line.includes("file-")).length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThanOrEqual(8);
      expect(lines.join("\n")).toContain(`… +${15 - shown} more`);
    },
  );

  it("hides only on narrow or short terminals and can become visible again after resize", async () => {
    const app = mount();
    await app.emit("session_start");
    const visible = app.options()?.overlayOptions;
    expect(typeof visible).toBe("object");
    if (typeof visible !== "object") throw new Error("Expected overlay options");
    expect(visible?.visible?.(79, 40)).toBe(false);
    expect(visible?.visible?.(120, 9)).toBe(false);
    expect(visible?.visible?.(80, 10)).toBe(true);
    expect(visible?.visible?.(160, 40)).toBe(true);
  });

  it("refreshes relevant tool events, agent end and polling with fresh context objects", async () => {
    const app = mount();
    await app.emit("session_start");
    await app.emit("tool_execution_end", { toolName: "read" });
    expect(app.exec).toHaveBeenCalledOnce();
    for (const toolName of ["edit", "write", "bash"]) {
      app.exec.mockResolvedValue(result(` M ${toolName}.ts\n`));
      await app.emit("tool_execution_end", { toolName });
      expect(app.text()).toContain(`${toolName}.ts`);
    }
    app.exec.mockResolvedValue(result("?? poll.txt\n"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(app.text()).toContain("poll.txt");
    app.exec.mockResolvedValue(result(" M settled.ts\n"));
    await app.emit("agent_end");
    expect(app.text()).toContain("settled.ts");
    expect(app.exec).toHaveBeenCalledTimes(6);
  });

  it("does not repaint unchanged git data and coalesces concurrent refreshes", async () => {
    const app = mount();
    await app.emit("session_start");
    const renders = app.tui.requestRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(app.tui.requestRender).toHaveBeenCalledTimes(renders);
    const pending = deferred<ExecResult>();
    app.exec.mockReturnValueOnce(pending.promise);
    const refresh = app.emit("tool_execution_end", { toolName: "edit" });
    await app.emit("tool_execution_end", { toolName: "write" });
    await app.emit("tool_execution_end", { toolName: "bash" });
    expect(app.exec).toHaveBeenCalledTimes(3);
    pending.resolve(result(" M app.ts\n"));
    await refresh;
    expect(app.exec).toHaveBeenCalledTimes(4);
  });

  it("closes once on shutdown and ignores late git results and events without restarting polling", async () => {
    const app = mount();
    const pending = deferred<ExecResult>();
    app.exec.mockReturnValueOnce(pending.promise);
    await app.emit("session_start");
    await app.emit("session_shutdown");
    expect(app.done).toHaveBeenCalledOnce();
    const renders = app.tui.requestRender.mock.calls.length;
    pending.resolve(result(" M late.ts\n"));
    await Promise.resolve();
    await app.emit("tool_execution_end", { toolName: "write" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(app.exec).toHaveBeenCalledOnce();
    expect(app.text()).toBe("");
    expect(app.tui.requestRender).toHaveBeenCalledTimes(renders);
    await app.emit("session_shutdown");
    expect(app.done).toHaveBeenCalledOnce();
  });

  it("hides on nonzero git exit or rejection, reports a rejection once and recovers", async () => {
    const app = mount();
    await app.emit("session_start");
    app.exec.mockResolvedValue(result("", 128));
    await app.emit("agent_end");
    expect(app.text()).toBe("");
    expect(app.ui.notify).not.toHaveBeenCalled();
    app.exec.mockResolvedValue(result(" M recovered.ts\n"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(app.text()).toContain("recovered.ts");
    app.exec.mockRejectedValue(new Error("git unavailable"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(app.text()).toBe("");
    expect(app.ui.notify).toHaveBeenCalledExactlyOnceWith("Git status: git unavailable", "error");
    app.exec.mockResolvedValue(result("?? back.txt\n"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(app.text()).toContain("back.txt");
  });

  it.each(["tui", "rpc"])(
    "uses the configured widget in %s mode and clears it when clean",
    async (mode) => {
      writeFileSync(configPath, JSON.stringify({ display: "widget" }));
      const app = mount(" M src/app.ts\n", mode);
      await app.emit("session_start");
      expect(app.ui.custom).not.toHaveBeenCalled();
      expect(app.ui.setWidget).toHaveBeenCalledWith(
        "git-status",
        expect.arrayContaining([
          expect.stringContaining("Git status:"),
          expect.stringContaining("src/app.ts"),
        ]),
      );
      app.exec.mockResolvedValue(result("?? refreshed.txt\n"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(app.ui.setWidget).toHaveBeenLastCalledWith(
        "git-status",
        expect.arrayContaining([expect.stringContaining("refreshed.txt")]),
      );
      app.exec.mockResolvedValue(result());
      await app.emit("agent_end");
      expect(app.ui.setWidget).toHaveBeenLastCalledWith("git-status", undefined);
      expect(app.ui.notify).not.toHaveBeenCalled();
    },
  );

  it("uses the RPC widget even when configured for panel", async () => {
    writeFileSync(configPath, JSON.stringify({ display: "panel" }));
    const app = mount(" M src/app.ts\n", "rpc");
    await app.emit("session_start");
    expect(app.ui.custom).not.toHaveBeenCalled();
    expect(app.ui.setWidget).toHaveBeenCalledWith(
      "git-status",
      expect.arrayContaining([expect.stringContaining("src/app.ts")]),
    );
  });

  it.each(["{}", '{"display":"panel"}'])("uses the panel for config %s", async (config) => {
    writeFileSync(configPath, config);
    const app = mount();
    await app.emit("session_start");
    expect(app.ui.custom).toHaveBeenCalledOnce();
    expect(app.text()).toContain("src/app.ts");
    expect(app.ui.notify).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    "null",
    "[]",
    "true",
    '{"display":"sidebar"}',
    '{"display":25}',
    '{"display":null}',
  ])("warns once and falls back to panel for invalid config %s", async (config) => {
    writeFileSync(configPath, config);
    const app = mount();
    await app.emit("session_start");
    expect(app.ui.custom).toHaveBeenCalledOnce();
    expect(app.text()).toContain("src/app.ts");
    await vi.advanceTimersByTimeAsync(10000);
    expect(app.ui.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Git status config (${configPath}):`),
      "warning",
    );
  });

  it("warns and falls back to panel when config cannot be read", async () => {
    mkdirSync(configPath);
    const app = mount();
    await app.emit("session_start");
    expect(app.ui.custom).toHaveBeenCalledOnce();
    expect(app.text()).toContain("src/app.ts");
    expect(app.ui.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Git status config (${configPath}):`),
      "warning",
    );
  });

  it("reads config only at session start and switches display after reload", async () => {
    const initial = mount();
    await initial.emit("session_start");
    writeFileSync(configPath, JSON.stringify({ display: "widget" }));
    await initial.emit("agent_end");
    expect(initial.ui.setWidget).not.toHaveBeenCalled();
    await initial.emit("session_shutdown", { reason: "reload" });
    expect(initial.done).toHaveBeenCalledOnce();

    const widget = mount();
    await widget.emit("session_start", { reason: "reload" });
    expect(widget.ui.custom).not.toHaveBeenCalled();
    expect(widget.ui.setWidget).toHaveBeenCalledWith("git-status", expect.any(Array));
    writeFileSync(configPath, JSON.stringify({ display: "panel" }));
    await widget.emit("session_shutdown", { reason: "reload" });
    expect(widget.ui.setWidget).toHaveBeenLastCalledWith("git-status", undefined);

    const panel = mount();
    await panel.emit("session_start", { reason: "reload" });
    expect(panel.ui.custom).toHaveBeenCalledOnce();
    expect(panel.text()).toContain("src/app.ts");
    expect(panel.ui.setWidget).not.toHaveBeenCalled();
  });
});
