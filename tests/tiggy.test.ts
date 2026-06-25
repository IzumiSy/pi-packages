import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tiggyExtension from "../extensions/tiggy/main";
import {
	countNonEmptyLines,
	findMatchingLineIndexes,
	formatCommandError,
	parseBranchLabel,
	parseCommitItems,
	sanitizePreviewText,
	wrapBlock,
} from "../extensions/tiggy/core";
import { describe, expect, it } from "vitest";

const ENTER = "\r";
const ESCAPE = "\u001b";
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

interface RenderController {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
}

interface ExecCall {
	command: string;
	args: string[];
}

interface MountedTiggy {
	render(): string;
	press(data: string): Promise<void>;
	close(): Promise<void>;
	commandPromise: Promise<void>;
	execCalls: ExecCall[];
}

function makeExecResult(stdout: string, stderr = "", code = 0) {
	return { stdout, stderr, code };
}

function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

async function flushUi(): Promise<void> {
	await delay(0);
}

async function waitForController(getController: () => RenderController | undefined): Promise<RenderController> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const controller = getController();
		if (controller) return controller;
		await flushUi();
	}
	throw new Error("tiggy controller was not mounted");
}

async function mountTiggy(): Promise<MountedTiggy> {
	const execCalls: ExecCall[] = [];
	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let controller: RenderController | undefined;
	let done: (() => void) | undefined;

	const commitPreview = Array.from({ length: 30 }, (_, index) => {
		if (index === 0) return "commit abc1234";
		if (index === 1) return "Author: Alice";
		if (index === 2) return "Date: 2026-06-25";
		if (index === 10) return "needle first";
		if (index === 20) return "needle second";
		return `line ${index + 1}`;
	}).join("\n");

	const secondCommitPreview = ["commit def5678", "Author: Bob", "Date: 2026-06-24", "line 4", "line 5"].join("\n");

	const pi = {
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			if (command !== "git") {
				throw new Error(`Unexpected command: ${command}`);
			}

			if (args[0] === "rev-parse") {
				return makeExecResult("/repo\n");
			}
			if (args[0] === "status" && args[1] === "--short" && args[2] === "--branch") {
				return makeExecResult("## main...origin/main\n M src/app.ts\n?? notes.txt\n");
			}
			if (args[0] === "status" && args[1] === "--porcelain=v1") {
				return makeExecResult(" M src/app.ts\n?? notes.txt\n");
			}
			if (args[0] === "log") {
				return makeExecResult([
					"abc1234\t2026-06-25\tAlice\tfeat: ship tiggy",
					"def5678\t2026-06-24\tBob\tfix: preview search",
				].join("\n"));
			}
			if (args[0] === "diff" && args[1] === "--cached") {
				return makeExecResult(" staged.txt | 1 +\n@@\n+staged change\n");
			}
			if (args[0] === "diff") {
				return makeExecResult(" src/app.ts | 3 +++\n@@\n+needle alpha\n+middle line\n+needle beta\n");
			}
			if (args[0] === "ls-files") {
				return makeExecResult("notes.txt\n");
			}
			if (args[0] === "show" && args.at(-1) === "abc1234") {
				return makeExecResult(commitPreview);
			}
			if (args[0] === "show" && args.at(-1) === "def5678") {
				return makeExecResult(secondCommitPreview);
			}

			throw new Error(`Unexpected git args: ${args.join(" ")}`);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			if (name === "tiggy") {
				commandHandler = options.handler;
			}
		},
	} as unknown as ExtensionAPI;

	tiggyExtension(pi);
	if (!commandHandler) throw new Error("tiggy command handler was not registered");

	const closePromise = new Promise<void>((resolve) => {
		done = resolve;
	});

	const tui = {
		terminal: { columns: 140, rows: 20 },
		requestRender: () => {},
	};

	const ctx = {
		cwd: "/repo",
		mode: "tui",
		ui: {
			notify: () => {},
			custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => RenderController) => {
				controller = await factory(tui, createTheme(), {}, () => done?.());
				return closePromise;
			},
		},
	};

	const commandPromise = commandHandler("", ctx);
	const mountedController = await waitForController(() => controller);
	await flushUi();

	return {
		render: () => mountedController.render(tui.terminal.columns).join("\n"),
		press: async (data: string) => {
			mountedController.handleInput(data);
			await flushUi();
		},
		close: async () => {
			mountedController.handleInput(ESCAPE);
			await commandPromise;
		},
		commandPromise,
		execCalls,
	};
}

describe("tiggy core", () => {
	it("prefers stderr, then stdout, then exit code when formatting command errors", () => {
		expect(formatCommandError({ stdout: "ok", stderr: " boom  ", code: 1 })).toBe("boom");
		expect(formatCommandError({ stdout: "  fallback ", stderr: "", code: 2 })).toBe("fallback");
		expect(formatCommandError({ stdout: "", stderr: "", code: 7 })).toBe("command exited with code 7");
	});

	it("counts only non-empty trimmed lines", () => {
		expect(countNonEmptyLines("\n foo \n\t\nbar\n  baz  \n")).toBe(3);
	});

	it("parses the branch label from git status output and falls back to git", () => {
		expect(parseBranchLabel("## main...origin/main\n M src/index.ts\n")).toBe("main...origin/main");
		expect(parseBranchLabel("\n M src/index.ts\n")).toBe("git");
	});

	it("parses commit items, keeps tab characters in subjects, and adds the requested start index", () => {
		const items = parseCommitItems(
			[
				"abc1234\t2026-06-25\tAlice\tfeat: ship tiggy",
				"def5678\t2026-06-24\tBob\tfix:\tkeep tabs",
				"ghi9012\t2026-06-23\tCarol",
			].join("\n"),
			5,
		);

		expect(items).toEqual([
			{
				type: "commit",
				key: "commit:abc1234",
				sha: "abc1234",
				date: "2026-06-25",
				author: "Alice",
				subject: "feat: ship tiggy",
				label: "abc1234 feat: ship tiggy",
				description: "2026-06-25 • Alice",
				index: 5,
			},
			{
				type: "commit",
				key: "commit:def5678",
				sha: "def5678",
				date: "2026-06-24",
				author: "Bob",
				subject: "fix:\tkeep tabs",
				label: "def5678 fix:\tkeep tabs",
				description: "2026-06-24 • Bob",
				index: 6,
			},
			{
				type: "commit",
				key: "commit:ghi9012",
				sha: "ghi9012",
				date: "2026-06-23",
				author: "Carol",
				subject: "(no subject)",
				label: "ghi9012 (no subject)",
				description: "2026-06-23 • Carol",
				index: 7,
			},
		]);
	});

	it("sanitizes preview text and wraps already-sanitized lines when width is large enough", () => {
		expect(sanitizePreviewText("a\tb\u001bc\u0007")).toBe("a    b^[c?");
		expect(wrapBlock("a\tb\u001bc", 20)).toEqual(["a    b^[c"]);
		expect(wrapBlock("", 20)).toEqual([" "]);
		expect(wrapBlock("ignored", 0)).toEqual([""]);
	});

	it("finds matching preview lines case-insensitively after trimming the query", () => {
		expect(findMatchingLineIndexes(["alpha", "Beta release", "gamma beta"], "  BETA ")).toEqual([1, 2]);
		expect(findMatchingLineIndexes(["alpha"], "   ")).toEqual([]);
	});
});

describe("tiggy TUI", () => {
	it("opens the working tree preview, searches within it, and closes just the preview with q", async () => {
		const tiggy = await mountTiggy();

		expect(tiggy.render()).toContain("Press Enter to preview.");

		await tiggy.press(ENTER);
		expect(tiggy.render()).toContain("WORKING TREE");

		await tiggy.press("/");
		for (const key of ["n", "e", "e", "d", "l", "e"]) {
			await tiggy.press(key);
		}
		await tiggy.press(ENTER);
		expect(tiggy.render()).toContain("1/2 matches");

		await tiggy.press(ESCAPE);
		expect(tiggy.render()).not.toContain("1/2 matches");
		expect(tiggy.render()).toContain("WORKING TREE");

		await tiggy.press("q");
		expect(tiggy.render()).toContain("Press Enter to preview.");

		await tiggy.close();
	});

	it("navigates to a commit preview, scrolls it by page, and exits the overlay with escape", async () => {
		const tiggy = await mountTiggy();

		await tiggy.press("j");
		await tiggy.press(ENTER);
		expect(tiggy.render()).toContain("commit abc1234");
		expect(tiggy.render()).toContain("preview 1-12/30");

		await tiggy.press(PAGE_DOWN);
		expect(tiggy.render()).toContain("preview 13-24/30");

		await tiggy.press(PAGE_UP);
		expect(tiggy.render()).toContain("preview 1-12/30");

		await tiggy.press(ESCAPE);
		await tiggy.commandPromise;
		expect(tiggy.execCalls.some((call) => call.args[0] === "show" && call.args.at(-1) === "abc1234")).toBe(true);
	});
});
