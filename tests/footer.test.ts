import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import footerExtension from "../extensions/footer/main.ts";

vi.mock("node:os", () => ({
  hostname: () => "workstation",
  userInfo: () => ({ username: "developer" }),
  homedir: () => "/home/developer",
}));

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

function mount(mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const state = {
    cwd: "/home/developer/project",
    model: { id: "test-model" } as ExtensionContext["model"],
    level: "high" as ReturnType<ExtensionAPI["getThinkingLevel"]>,
    usage: { tokens: 42100, contextWindow: 100000, percent: 42.1 } as ReturnType<
      ExtensionContext["getContextUsage"]
    >,
    branch: "main" as string | null,
    color: "32",
  };
  const statuses = new Map<string, string>();
  const requestRender = vi.fn();
  const unsubscribe = vi.fn();
  let branchChanged: (() => void) | undefined;
  let component: ReturnType<FooterFactory> | undefined;
  const ui = {
    theme: {
      fg: (_color: string, text: string) => `\u001b[${state.color}m${text}\u001b[39m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    },
    setFooter: vi.fn((factory: FooterFactory | undefined) => {
      component?.dispose?.();
      component = factory?.(
        { requestRender } as unknown as Parameters<FooterFactory>[0],
        ui.theme as unknown as Parameters<FooterFactory>[1],
        {
          getGitBranch: () => state.branch,
          getExtensionStatuses: () => statuses,
          getAvailableProviderCount: () => 1,
          onBranchChange: (callback) => {
            branchChanged = callback;
            return unsubscribe;
          },
        },
      );
    }),
  };
  const ctx = {
    mode,
    ui,
    get cwd() {
      return state.cwd;
    },
    get model() {
      return state.model;
    },
    getContextUsage: () => state.usage,
  } as unknown as ExtensionContext;
  footerExtension({
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    getThinkingLevel: () => state.level,
  } as unknown as ExtensionAPI);
  const emit = (name: string) => handlers.get(name)?.({} as never, ctx);
  const lines = (width = 100) => component?.render(width) ?? [];
  return {
    state,
    statuses,
    ui,
    requestRender,
    unsubscribe,
    emit,
    lines,
    text: (width = 100) => lines(width).map(stripTerminalSequences).join("\n"),
    branchChanged: () => branchChanged?.(),
    invalidate: () => component?.invalidate(),
  };
}

describe("footer", () => {
  it("mounts at session start with environment left and model, effort and context right", () => {
    const app = mount();
    expect(app.ui.setFooter).not.toHaveBeenCalled();
    app.emit("session_start");
    expect(app.lines()).toHaveLength(1);
    expect(app.text()).toMatch(
      /^workstation@developer ~\/project \(main\) +test-model \(high\) \| ctx 42\.1%$/,
    );
    expect(app.lines()[0]).toContain("\u001b[1mworkstation@developer\u001b[22m ~/project");
    expect(visibleWidth(app.lines()[0]!)).toBe(100);
  });

  it.each(["rpc", "print", "json"] as const)("does not replace the footer in %s mode", (mode) => {
    const app = mount(mode);
    app.emit("session_start");
    app.emit("session_shutdown");
    expect(app.ui.setFooter).not.toHaveBeenCalled();
  });

  it.each([
    ["/home/developer", "~"],
    ["/home/developer/project", "~/project"],
    ["/home/developer-other/project", "/home/developer-other/project"],
    ["/tmp/project", "/tmp/project"],
  ])("shortens only the actual home directory for %s", (cwd, path) => {
    const app = mount();
    app.state.cwd = cwd;
    app.emit("session_start");
    expect(app.text(160)).toContain(`workstation@developer ${path} (main)`);
  });

  it("reads current model, effort, branch, cwd and usage on each render", () => {
    const app = mount();
    app.emit("session_start");
    app.state.model = { id: "next-model" } as ExtensionContext["model"];
    app.state.level = "off";
    app.state.branch = "feature";
    app.state.cwd = "/tmp/new-project";
    app.state.usage = { tokens: 0, contextWindow: 100000, percent: 0 };
    app.branchChanged();
    expect(app.requestRender).toHaveBeenCalledOnce();
    expect(app.text()).toContain("/tmp/new-project (feature)");
    expect(app.text()).toMatch(/next-model \(off\) \| ctx 0\.0%$/);
    expect(app.ui.setFooter).toHaveBeenCalledOnce();
  });

  it("handles non-repositories, detached HEAD, missing models and unknown context", () => {
    const app = mount();
    app.state.branch = null;
    app.state.model = undefined;
    app.state.level = "off";
    app.state.usage = undefined;
    app.emit("session_start");
    expect(app.text()).toMatch(/~\/project +no-model \(off\) \| ctx \?%$/);
    app.state.branch = "detached";
    app.state.usage = { tokens: null, contextWindow: 100000, percent: null };
    expect(app.text()).toContain("(detached)");
    expect(app.text()).toMatch(/ctx \?%$/);
  });

  it("prioritizes the right side at narrow widths and fits Unicode and ANSI within columns", () => {
    const app = mount();
    app.state.cwd = `/home/developer/${"長い🚀/".repeat(20)}`;
    app.emit("session_start");
    for (let width = 0; width <= 160; width++) {
      for (const line of app.lines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (width >= 32) expect(app.text(width)).toMatch(/test-model \(high\) \| ctx 42\.1%$/);
    }
    expect(app.text(60)).toContain("…");
  });

  it("sanitizes terminal control sequences and multiline paths before rendering", () => {
    const app = mount();
    app.state.cwd = "/tmp/\u001b[31mred\u001b[0m\nproject\t\u0007";
    app.emit("session_start");
    expect(app.text()).toContain("/tmp/red project");
    expect(app.text()).not.toMatch(/\p{Cc}/u);
    expect(app.lines().join("")).not.toContain("\u001b[31m");
  });

  it("keeps other extensions' statuses sorted on a separate line with their colors", () => {
    const app = mount();
    app.statuses.set("z", "last\nstatus");
    app.statuses.set("a", "\u001b[33mfirst\u001b[39m");
    app.emit("session_start");
    expect(app.lines()).toHaveLength(2);
    expect(app.text().split("\n")[1]).toBe("first last status");
    expect(app.lines()[1]).toContain("\u001b[33m");
    expect(visibleWidth(app.lines(10)[1]!)).toBeLessThanOrEqual(10);
  });

  it("rebuilds theme colors and unsubscribes when shutdown restores the built-in footer", () => {
    const app = mount();
    app.emit("session_start");
    app.state.color = "31";
    app.invalidate();
    expect(app.lines()[0]).toContain("\u001b[31m");
    app.emit("session_shutdown");
    expect(app.ui.setFooter).toHaveBeenLastCalledWith(undefined);
    expect(app.unsubscribe).toHaveBeenCalledOnce();
    app.emit("session_start");
    expect(app.text()).toContain("test-model (high)");
  });
});
