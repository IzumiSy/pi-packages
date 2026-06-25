import { createLocalBashOperations, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "git-status";
const POLL_INTERVAL_MS = 5000;
const MAX_VISIBLE_FILES = 8;
const REFRESH_TOOLS = new Set(["edit", "write", "bash"]);

type GitFile = {
	status: string;
	path: string;
};

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
	return status[0] && status[0] !== " " ? status[0] : (status[1] && status[1] !== " " ? status[1] : "?");
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

	function clearWidget(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}

	async function renderWidget(ctx: ExtensionContext): Promise<void> {
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
		const nextState = visibleGitFiles.map((file) => `${file.status} ${file.path}`).join("\n");
		if (nextState === lastRenderedState) return;
		lastRenderedState = nextState;

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
		if (!ctx.hasUI) return;
		activeContext = ctx;

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
		// ponytail: events handle pi-driven changes; keep a slow poll only for edits happening outside pi.
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
		activeContext = undefined;
		lastRenderedState = undefined;
		refreshQueued = false;
		clearWidget(ctx);
	});
}
