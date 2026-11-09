import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalBashOperations,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const WIDGET_ID = "git-status";
const POLL_INTERVAL_MS = 5000;
const MAX_VISIBLE_FILES = 8;
const REFRESH_TOOLS = new Set(["edit", "write", "bash"]);

type GitFile = {
  status: string;
  path: string;
};

function readDisplay(ctx: ExtensionContext): "panel" | "widget" {
  const path = join(getAgentDir(), "git-status-widget.json");
  try {
    const config: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Expected a JSON object");
    }
    const display = "display" in config ? config.display : undefined;
    if (display === undefined) return "panel";
    if (display === "panel" || display === "widget") return display;
    throw new Error('display must be "panel" or "widget"');
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      ctx.ui.notify(
        `Git status config (${path}): ${error instanceof Error ? error.message : String(error)}; using panel`,
        "warning",
      );
    }
    return "panel";
  }
}

function parseVisibleFiles(stdout: string): GitFile[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .flatMap<GitFile>((line) => {
      if (line.startsWith("!! ")) {
        return [];
      }

      if (line.startsWith("?? ")) {
        return [{ status: "??", path: line.slice(3).trim() } satisfies GitFile];
      }

      const status = line.slice(0, 2);
      const path = line.slice(3).trim();
      const indexStatus = status[0];
      const worktreeStatus = status[1];
      const hasIndexChange = indexStatus !== undefined && indexStatus !== " ";
      const hasWorktreeChange = worktreeStatus !== undefined && worktreeStatus !== " ";
      if (!hasIndexChange && !hasWorktreeChange) {
        return [];
      }

      return [{ status, path } satisfies GitFile];
    });
}

function primaryStatusChar(status: string): string {
  return status[0] && status[0] !== " "
    ? status[0]
    : status[1] && status[1] !== " "
      ? status[1]
      : "?";
}

function statusColor(status: string): "accent" | "error" | "success" | "warning" {
  switch (primaryStatusChar(status)) {
    case "A":
      return "success";
    case "D":
    case "U":
      return "error";
    case "R":
    case "C":
    case "?":
      return "accent";
    default:
      return "warning";
  }
}

export default function gitStatusWidgetExtension(pi: ExtensionAPI) {
  let pollTimer: NodeJS.Timeout | undefined;
  let refreshInFlight = false;
  let refreshQueued = false;
  let lastRenderedState: string | undefined;
  let activeContext: ExtensionContext | undefined;
  let panelTui: TUI | undefined;
  let panelFiles: GitFile[] | undefined;
  let closePanel: (() => void) | undefined;
  let generation = 0;
  let display: "panel" | "widget" = "panel";

  function clearWidget(ctx: ExtensionContext | undefined): void {
    panelFiles = undefined;
    panelTui?.requestRender();
    if (!ctx?.hasUI) return;
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }

  function openPanel(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || display !== "panel") return;
    const currentGeneration = generation;
    void ctx.ui
      .custom<void>(
        (tui, _theme, _keybindings, done) => {
          panelTui = tui;
          closePanel = () => done();
          return {
            render(width: number): string[] {
              if (!panelFiles) return [];
              const theme = ctx.ui.theme;
              const innerWidth = Math.max(0, width - 4);
              const fileRows = Math.max(0, Math.floor(tui.terminal.rows / 2) - 3);
              const limit = Math.min(MAX_VISIBLE_FILES, fileRows);
              const count = Math.max(0, limit - (panelFiles.length > limit ? 1 : 0));
              const lines = [theme.fg("dim", `Git changes (${panelFiles.length})`)];
              for (const file of panelFiles.slice(0, count)) {
                const pathWidth = Math.max(0, innerWidth - 3);
                const fullWidth = visibleWidth(file.path);
                const path =
                  fullWidth > pathWidth
                    ? `…${sliceByColumn(file.path, fullWidth - pathWidth + 1, Math.max(0, pathWidth - 1), true)}`
                    : file.path;
                lines.push(`${theme.fg(statusColor(file.status), file.status)} ${path}`);
              }
              if (panelFiles.length > count) {
                lines.push(theme.fg("dim", `… +${panelFiles.length - count} more`));
              } else if (panelFiles.length === 0) {
                lines.push(theme.fg("dim", "Working tree clean"));
              }
              const border = "─".repeat(Math.max(0, width - 2));
              return [
                theme.fg("dim", `╭${border}╮`),
                ...lines.map(
                  (line) =>
                    `${theme.fg("dim", "│")} ${truncateToWidth(line, innerWidth, "…", true)} ${theme.fg("dim", "│")}`,
                ),
                theme.fg("dim", `╰${border}╯`),
              ];
            },
            invalidate() {},
          };
        },
        {
          overlay: true,
          overlayOptions: {
            nonCapturing: true,
            anchor: "top-right",
            width: "25%",
            maxHeight: "50%",
            margin: { top: 1, right: 1 },
            visible: (columns, rows) => columns >= 80 && rows >= 10,
          },
        },
      )
      .catch((error: unknown) => {
        if (generation === currentGeneration && activeContext) {
          ctx.ui.notify(
            `Git status panel: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      });
  }

  async function renderWidget(ctx: ExtensionContext): Promise<void> {
    const currentGeneration = generation;
    const result = await pi.exec(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain=v1"],
      {
        cwd: ctx.cwd,
        timeout: 5_000,
      },
    );
    if (!activeContext || generation !== currentGeneration) return;

    if (result.code !== 0) {
      if (lastRenderedState !== "__hidden__") {
        lastRenderedState = "__hidden__";
        clearWidget(ctx);
      }
      return;
    }

    const visibleGitFiles = parseVisibleFiles(result.stdout);
    const nextState = visibleGitFiles.map((file) => `${file.status} ${file.path}`).join("\n");
    if (nextState === lastRenderedState) return;
    lastRenderedState = nextState;

    if (ctx.mode === "tui" && display === "panel") {
      panelFiles = visibleGitFiles;
      panelTui?.requestRender();
      return;
    }

    if (visibleGitFiles.length === 0) {
      clearWidget(ctx);
      return;
    }

    const visibleFiles = visibleGitFiles.slice(0, MAX_VISIBLE_FILES);
    const lines = [ctx.ui.theme.fg("dim", "Git status:")];
    for (const file of visibleFiles) {
      lines.push(`${ctx.ui.theme.fg(statusColor(file.status), file.status)} ${file.path}`);
    }
    if (visibleGitFiles.length > MAX_VISIBLE_FILES) {
      lines.push(ctx.ui.theme.fg("dim", `… +${visibleGitFiles.length - MAX_VISIBLE_FILES} more`));
    }
    lines.push(" ");

    ctx.ui.setWidget(WIDGET_ID, lines);
  }

  async function refreshWidget(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || !activeContext) return;
    activeContext = ctx;
    const currentGeneration = generation;

    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    refreshInFlight = true;
    try {
      do {
        refreshQueued = false;
        const currentCtx = activeContext;
        if (!currentCtx?.hasUI) return;
        await renderWidget(currentCtx);
      } while (refreshQueued);
    } catch (error: unknown) {
      if (activeContext && generation === currentGeneration && lastRenderedState !== "__hidden__") {
        lastRenderedState = "__hidden__";
        clearWidget(ctx);
        ctx.ui.notify(
          `Git status: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    } finally {
      refreshInFlight = false;
    }
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function startPolling(ctx: ExtensionContext): void {
    stopPolling();
    activeContext = ctx;
    generation += 1;
    lastRenderedState = undefined;
    openPanel(ctx);
    void refreshWidget(ctx);
    // shortcut: external edits refresh every five seconds; use file watching if faster updates are needed.
    pollTimer = setInterval(() => {
      if (!activeContext) return;
      void refreshWidget(activeContext);
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    display = readDisplay(ctx);
    startPolling(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!REFRESH_TOOLS.has(event.toolName)) return;
    await refreshWidget(ctx);
  });

  pi.on("user_bash", (event, ctx) => {
    const local = createLocalBashOperations();
    return {
      operations: {
        ...local,
        async exec(command, cwd, options) {
          const result = await local.exec(command, cwd, options);
          if (event.command.trim() !== "") {
            void refreshWidget(ctx);
          }
          return result;
        },
      },
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refreshWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPolling();
    generation += 1;
    activeContext = undefined;
    lastRenderedState = undefined;
    refreshQueued = false;
    closePanel?.();
    closePanel = undefined;
    panelTui = undefined;
    clearWidget(ctx);
  });
}
