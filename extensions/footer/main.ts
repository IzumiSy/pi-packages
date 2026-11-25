import { homedir, hostname, userInfo } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function singleLine(text: string): string {
  return stripTerminalSequences(text).replace(/\p{Cc}/gu, " ");
}

export default function footerExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const machine = hostname();
    const user = userInfo().username;
    const home = homedir();

    ctx.ui.setFooter((tui, _theme, footerData) => ({
      dispose: footerData.onBranchChange(() => tui.requestRender()),
      invalidate() {},
      render(width: number): string[] {
        const theme = ctx.ui.theme;
        const cwd = ctx.cwd;
        const path =
          cwd === home ? "~" : cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
        const branch = footerData.getGitBranch();
        const leftText =
          theme.bold(singleLine(`${machine}@${user}`)) +
          singleLine(` ${path}${branch ? ` (${branch})` : ""}`);
        const percent = ctx.getContextUsage()?.percent;
        const context = percent == null ? "ctx ?%" : `ctx ${percent.toFixed(1)}%`;
        const rightText = singleLine(
          `${ctx.model?.id ?? "no-model"} (${pi.getThinkingLevel()}) | ${context}`,
        );
        const right = theme.fg("dim", truncateToWidth(rightText, width, "…"));
        const leftWidth = Math.max(0, width - visibleWidth(right) - 2);
        const left = theme.fg("dim", truncateToWidth(leftText, leftWidth, "…"));
        const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
        const lines = [left + padding + right];

        const statuses = footerData.getExtensionStatuses();
        if (statuses.size > 0) {
          const statusLine = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text.replace(/[\r\n\t]/g, " "))
            .join(" ");
          lines.push(truncateToWidth(statusLine, width, "…"));
        }
        return lines;
      },
    }));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
