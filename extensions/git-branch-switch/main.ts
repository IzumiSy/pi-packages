import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { matchSorter, rankings } from "match-sorter";

type BranchKind = "local" | "remote";
type SwitchMode = "branches" | "prs";

type SwitchItem = BranchInfo | PullRequestInfo;

interface BranchInfo {
	type: "branch";
	key: string;
	name: string;
	shortName: string;
	kind: BranchKind;
	current: boolean;
	description: string;
	label: string;
}

interface PullRequestInfo {
	type: "pr";
	key: string;
	number: number;
	title: string;
	headRefName: string;
	author: string;
	isDraft: boolean;
	updatedAt: string;
	label: string;
	description: string;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

interface GithubPrListItem {
	number: number;
	title: string;
	headRefName: string;
	author?: {
		login?: string | null;
	} | null;
	isDraft: boolean;
	updatedAt: string;
}

function formatCommandError(result: CommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `command exited with code ${result.code}`;
}

function formatUpdatedAt(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function parseBranchLines(stdout: string, kind: BranchKind, currentBranch: string): BranchInfo[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [name = "", when = "", subject = ""] = line.split("\t");
			const shortName = kind === "remote" ? name.replace(/^[^/]+\//, "") : name;
			const current = kind === "local" && name === currentBranch;
			const description = [kind === "remote" ? "remote" : undefined, when, subject].filter(Boolean).join(" • ");

			return {
				type: "branch",
				key: `${kind}:${name}`,
				name,
				shortName,
				kind,
				current,
				description,
				label: name,
			} satisfies BranchInfo;
		})
		.filter((branch) => branch.name !== "" && !branch.name.endsWith("/HEAD"));
}

function buildInlineMeta(item: SwitchItem): string {
	if (item.type === "branch") {
		return [item.kind === "remote" ? "remote" : undefined, item.description].filter(Boolean).join(" • ");
	}

	return [item.headRefName, item.author ? `@${item.author}` : undefined, item.isDraft ? "draft" : undefined, item.updatedAt]
		.filter(Boolean)
		.join(" • ");
}

function getSearchTexts(item: SwitchItem): string[] {
	if (item.type === "branch") {
		return [item.shortName, item.name];
	}

	return [`#${item.number}`, String(item.number), item.title, item.headRefName, item.author];
}

function filterItems<T extends SwitchItem>(items: T[], rawQuery: string): T[] {
	const query = rawQuery.trim();
	if (!query) return items;

	return matchSorter(items, query, {
		keys: [(item) => getSearchTexts(item)],
		threshold: rankings.CONTAINS,
		baseSort: (a, b) => a.index - b.index,
	});
}

function findBestMatch<T extends SwitchItem>(items: T[], rawQuery: string): T | undefined {
	const matches = filterItems(items, rawQuery);
	return matches.length === 1 ? matches[0] : undefined;
}

export default function gitBranchSwitchExtension(pi: ExtensionAPI) {
	async function run(ctx: ExtensionCommandContext, command: string, args: string[], timeout = 10_000): Promise<CommandResult> {
		const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout });
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.code,
		};
	}

	async function loadBranches(ctx: ExtensionCommandContext): Promise<BranchInfo[] | { error: string }> {
		const repoCheck = await run(ctx, "git", ["rev-parse", "--git-dir"]);
		if (repoCheck.code !== 0) {
			return { error: formatCommandError(repoCheck) };
		}

		const currentResult = await run(ctx, "git", ["branch", "--show-current"]);
		const currentBranch = currentResult.code === 0 ? currentResult.stdout.trim() : "";
		const format = "%(refname:short)%09%(committerdate:relative)%09%(subject)";

		const localResult = await run(ctx, "git", ["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads"]);
		if (localResult.code !== 0) {
			return { error: formatCommandError(localResult) };
		}

		const remoteResult = await run(ctx, "git", [
			"for-each-ref",
			"--sort=-committerdate",
			`--format=${format}`,
			"refs/remotes",
		]);
		if (remoteResult.code !== 0) {
			return { error: formatCommandError(remoteResult) };
		}

		const allLocalBranches = parseBranchLines(localResult.stdout, "local", currentBranch);
		const localNames = new Set(allLocalBranches.map((branch) => branch.name));
		const localBranches = allLocalBranches.filter((branch) => !branch.current);
		const remoteBranches = parseBranchLines(remoteResult.stdout, "remote", currentBranch).filter(
			(branch) => !localNames.has(branch.shortName),
		);

		return [...localBranches, ...remoteBranches];
	}

	async function loadPullRequests(ctx: ExtensionCommandContext): Promise<PullRequestInfo[] | { error: string }> {
		const result = await run(
			ctx,
			"gh",
			["pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,headRefName,author,isDraft,updatedAt"],
			30_000,
		);
		if (result.code !== 0) {
			return { error: formatCommandError(result) };
		}

		let items: GithubPrListItem[];
		try {
			items = JSON.parse(result.stdout) as GithubPrListItem[];
		} catch {
			return { error: "Failed to parse gh pr list output" };
		}

		return items.map((item) => ({
			type: "pr",
			key: `pr:${item.number}`,
			number: item.number,
			title: item.title,
			headRefName: item.headRefName,
			author: item.author?.login ?? "",
			isDraft: item.isDraft,
			updatedAt: formatUpdatedAt(item.updatedAt),
			label: `#${item.number} ${item.title}`,
			description: item.headRefName,
		} satisfies PullRequestInfo));
	}

	async function pickItem(
		ctx: ExtensionCommandContext,
		branches: BranchInfo[],
		prs: PullRequestInfo[],
		initialFilter = "",
		prError?: string,
	): Promise<SwitchItem | undefined> {
		if (ctx.mode !== "tui") return undefined;

		const picked = await ctx.ui.custom<SwitchItem | null>((tui, theme, _kb, done) => {
			const input = new Input();
			input.setValue(initialFilter);
			input.focused = true;

			let mode: SwitchMode = "branches";
			let selectedIndex = 0;
			let focused = true;

			const getModeItems = (): SwitchItem[] => (mode === "branches" ? branches : prs);
			const getModeError = () => (mode === "prs" ? prError : undefined);
			const getFiltered = () => filterItems(getModeItems(), input.getValue());
			const clampSelection = () => {
				const filtered = getFiltered();
				selectedIndex = filtered.length === 0 ? 0 : Math.max(0, Math.min(selectedIndex, filtered.length - 1));
				return filtered;
			};

			return {
				get focused() {
					return focused;
				},
				set focused(value: boolean) {
					focused = value;
					input.focused = value;
				},
				render(width: number) {
					const innerWidth = Math.max(1, width - 2);
					const filtered = clampSelection();
					const modePrompt = mode === "branches" ? "[Branches] > " : "[PRs] > ";
					const modeColor = mode === "branches" ? "success" : "warning";
					const promptWidth = visibleWidth(modePrompt);
					const rawInputLine = input.render(Math.max(1, innerWidth - promptWidth + 2))[0] ?? "";
					const inputLine = rawInputLine.startsWith("> ") ? rawInputLine.slice(2) : rawInputLine;
					const lines = [
						theme.fg("accent", "─".repeat(width)),
						` ${theme.fg("accent", theme.bold("Switch"))}`,
						"",
						` ${theme.fg(modeColor, modePrompt)}${inputLine}`,
						"",
					];

					const modeError = getModeError();
					if (modeError) {
						lines.push(` ${theme.fg("warning", truncateToWidth(modeError, innerWidth, ""))}`);
					} else if (filtered.length === 0) {
						lines.push(` ${theme.fg("warning", mode === "branches" ? "No matching branches" : "No matching pull requests")}`);
					} else {
						const maxVisible = 8;
						const startIndex = Math.max(
							0,
							Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible),
						);
						const visible = filtered.slice(startIndex, startIndex + maxVisible);

						for (let i = 0; i < visible.length; i++) {
							const item = visible[i]!;
							const absoluteIndex = startIndex + i;
							const selected = absoluteIndex === selectedIndex;
							const prefix = " ";
							const prefixWidth = visibleWidth(prefix);
							const rowWidth = Math.max(1, innerWidth - prefixWidth);
							const label = truncateToWidth(item.label, rowWidth, "");
							const remaining = Math.max(0, rowWidth - visibleWidth(label));
							const meta = buildInlineMeta(item);
							const metaText = meta && remaining > 2 ? `  ${theme.fg("muted", truncateToWidth(meta, remaining - 2, ""))}` : "";
							lines.push(`${prefix}${selected ? theme.fg("accent", label) : label}${metaText}`);
						}

						if (filtered.length > maxVisible) {
							lines.push("");
							lines.push(` ${theme.fg("dim", `(${selectedIndex + 1}/${filtered.length})`)}`);
						}
					}

					lines.push("");
					lines.push(` ${theme.fg("dim", "tab switch mode • type filter • ↑↓ navigate • enter select • esc cancel")}`);
					lines.push(theme.fg("accent", "─".repeat(width)));
					return lines;
				},
				invalidate() {
					input.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}

					if (matchesKey(data, Key.tab)) {
						mode = mode === "branches" ? "prs" : "branches";
						selectedIndex = 0;
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
						const filtered = clampSelection();
						if (filtered.length > 0) {
							selectedIndex =
								matchesKey(data, Key.up)
									? selectedIndex === 0
										? filtered.length - 1
										: selectedIndex - 1
									: selectedIndex === filtered.length - 1
										? 0
										: selectedIndex + 1;
						}
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						const filtered = clampSelection();
						done(filtered[selectedIndex] ?? null);
						return;
					}

					input.handleInput(data);
					selectedIndex = 0;
					tui.requestRender();
				},
			};
		});

		return picked ?? undefined;
	}

	async function switchToBranch(ctx: ExtensionCommandContext, branch: BranchInfo): Promise<void> {
		let args: string[];
		if (branch.kind === "local") {
			args = ["switch", branch.name];
		} else {
			const localExists = await run(ctx, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch.shortName}`]);
			args = localExists.code === 0 ? ["switch", branch.shortName] : ["switch", "--track", branch.name];
		}

		const result = await run(ctx, "git", args, 30_000);
		if (result.code !== 0) {
			ctx.ui.notify(formatCommandError(result), "error");
			return;
		}

		ctx.ui.notify(`Switched to ${branch.shortName}`, "info");
	}

	async function checkoutPullRequest(ctx: ExtensionCommandContext, pr: PullRequestInfo): Promise<void> {
		ctx.ui.notify("Switching to PR branch...", "info");
		const result = await run(ctx, "gh", ["pr", "checkout", String(pr.number), "--force"], 60_000);
		if (result.code !== 0) {
			ctx.ui.notify(formatCommandError(result), "error");
			return;
		}

		ctx.ui.notify(`Checked out PR #${pr.number}`, "info");
	}

	async function switchToItem(ctx: ExtensionCommandContext, item: SwitchItem): Promise<void> {
		if (item.type === "branch") {
			await switchToBranch(ctx, item);
			return;
		}

		await checkoutPullRequest(ctx, item);
	}

	pi.registerCommand("switch", {
		description: "Switch git branch or checkout pull request",
		handler: async (args, ctx) => {
			const branchesLoaded = await loadBranches(ctx);
			if ("error" in branchesLoaded) {
				ctx.ui.notify(branchesLoaded.error, "error");
				return;
			}

			const prsLoaded = await loadPullRequests(ctx);
			const prs = "error" in prsLoaded ? [] : prsLoaded;
			const prError = "error" in prsLoaded ? prsLoaded.error : undefined;

			const query = args.trim();
			const branchMatch = query ? findBestMatch(branchesLoaded, query) : undefined;
			if (branchMatch) {
				await switchToItem(ctx, branchMatch);
				return;
			}

			const prMatch = query ? findBestMatch(prs, query) : undefined;
			if (prMatch) {
				await switchToItem(ctx, prMatch);
				return;
			}

			if (branchesLoaded.length === 0 && prs.length === 0 && prError) {
				ctx.ui.notify(prError, "error");
				return;
			}

			if (ctx.mode !== "tui" && query) {
				ctx.ui.notify(`No unique branch or PR match for ${query}`, "error");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Use /switch <branch-or-pr> outside TUI mode", "warning");
				return;
			}

			const picked = await pickItem(ctx, branchesLoaded, prs, query, prError);
			if (!picked) return;
			await switchToItem(ctx, picked);
		},
	});
}
