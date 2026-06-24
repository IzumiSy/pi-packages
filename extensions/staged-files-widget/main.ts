import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "staged-files";
const POLL_INTERVAL_MS = 1500;
const MAX_VISIBLE_FILES = 8;

type GitFile = {
	kind: "staged" | "untracked";
	status: string;
	path: string;
};

function parseVisibleFiles(stdout: string): GitFile[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length >= 4)
		.flatMap<GitFile>((line) => {
			if (line.startsWith("?? ")) {
				return [{ kind: "untracked", status: "??", path: line.slice(3).trim() } satisfies GitFile];
			}

			const indexStatus = line[0];
			if (indexStatus === undefined || indexStatus === " " || indexStatus === "?" || indexStatus === "!") {
				return [];
			}

			return [{ kind: "staged", status: line.slice(0, 2), path: line.slice(3).trim() } satisfies GitFile];
		});
}

function statusColor(status: string): "accent" | "error" | "success" | "warning" {
	switch (status[0]) {
		case "A":
			return "success";
		case "D":
		case "U":
			return "error";
		case "R":
		case "C":
			return "accent";
		default:
			return "warning";
	}
}

export default function stagedFilesWidgetExtension(pi: ExtensionAPI) {
	let pollTimer: NodeJS.Timeout | undefined;
	let refreshInFlight = false;
	let lastRenderedState: string | undefined;
	let activeContext: ExtensionContext | undefined;

	function clearWidget(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}

	async function refreshWidget(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || refreshInFlight) return;
		refreshInFlight = true;

		try {
			const result = await pi.exec("git", ["status", "--porcelain=v1"], {
				cwd: ctx.cwd,
				timeout: 5_000,
			});

			if (result.code !== 0) {
				if (lastRenderedState !== "__hidden__") {
					lastRenderedState = "__hidden__";
					clearWidget(ctx);
				}
				return;
			}

			const visibleGitFiles = parseVisibleFiles(result.stdout);
			const nextState = visibleGitFiles.map((file) => `${file.kind}:${file.status} ${file.path}`).join("\n");
			if (nextState === lastRenderedState) return;
			lastRenderedState = nextState;

			if (visibleGitFiles.length === 0) {
				clearWidget(ctx);
				return;
			}

			const visibleFiles = visibleGitFiles.slice(0, MAX_VISIBLE_FILES);
			const lines = [ctx.ui.theme.fg("dim", "git")];
			for (const file of visibleFiles) {
				lines.push(`${ctx.ui.theme.fg(statusColor(file.status), file.status)} ${file.path}`);
			}
			if (visibleGitFiles.length > MAX_VISIBLE_FILES) {
				lines.push(ctx.ui.theme.fg("dim", `… +${visibleGitFiles.length - MAX_VISIBLE_FILES} more`));
			}

			ctx.ui.setWidget(WIDGET_ID, lines);
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
		lastRenderedState = undefined;
		void refreshWidget(ctx);
		// ponytail: poll git status instead of wiring every git-changing path; replace with a watcher only if this shows up in profiles.
		pollTimer = setInterval(() => {
			if (!activeContext) return;
			void refreshWidget(activeContext);
		}, POLL_INTERVAL_MS);
		pollTimer.unref?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		startPolling(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refreshWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopPolling();
		activeContext = undefined;
		lastRenderedState = undefined;
		clearWidget(ctx);
	});
}
