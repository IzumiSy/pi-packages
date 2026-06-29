import { highlightCode, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	countNonEmptyLines,
	findMatchingLineIndexes,
	formatCommandError,
	padLine,
	parseBranchLabel,
	parseCommitItems,
	sanitizePreviewText,
	type CommandResult,
	type StatusItem,
	type TiggyData,
	type TiggyItem,
	wrapBlock,
} from "./core";

function renderInlineLine(width: number, text: string): string {
	return truncateToWidth(text, width, "");
}

function renderListRow(
	item: TiggyItem,
	selected: boolean,
	width: number,
	theme: ExtensionCommandContext["ui"]["theme"],
	previewActive: boolean,
): string {
	const prefix = " ";
	const prefixWidth = visibleWidth(prefix);
	const labelWidth = Math.max(1, width - prefixWidth);
	const finishRow = (row: string) => {
		const padded = padLine(row, width);
		if (!selected) return padded;
		return previewActive ? theme.bold(padded) : theme.bg("selectedBg", padded);
	};

	if (item.type === "status") {
		const labelText = truncateToWidth(item.label, labelWidth, "");
		const labelStyled = selected ? theme.fg("accent", labelText) : labelText;
		const remaining = Math.max(0, labelWidth - visibleWidth(labelText));
		const metaText = remaining > 4 ? theme.fg("muted", truncateToWidth(` ${item.description}`, remaining, "")) : "";
		return finishRow(`${prefix}${labelStyled}${metaText}`);
	}

	const dateText = truncateToWidth(item.date, Math.min(10, labelWidth), "");
	const dateStyled = selected ? theme.fg("accent", dateText) : theme.fg("muted", dateText);
	const remainingAfterDate = Math.max(0, labelWidth - visibleWidth(dateText));
	const hashText = remainingAfterDate > 0 ? truncateToWidth(` ${item.sha}`, remainingAfterDate, "") : "";
	const hashStyled = theme.fg("success", hashText);
	const remainingAfterHash = Math.max(0, remainingAfterDate - visibleWidth(hashText));
	const subjectText = remainingAfterHash > 0 ? truncateToWidth(` ${item.subject}`, remainingAfterHash, "") : "";
	const subjectStyled = selected ? theme.fg("accent", subjectText) : subjectText;
	const remaining = Math.max(0, remainingAfterHash - visibleWidth(subjectText));
	const metaText = remaining > 4 ? theme.fg("muted", truncateToWidth(` ${item.author}`, remaining, "")) : "";
	return finishRow(`${prefix}${dateStyled}${hashStyled}${subjectStyled}${metaText}`);
}

function renderPreviewHeader(item: TiggyItem | undefined, width: number, theme: ExtensionCommandContext["ui"]["theme"]): string {
	if (!item) return padLine(theme.fg("accent", "preview"), width);
	if (item.type === "status") return padLine(theme.fg("accent", "working tree"), width);
	return padLine(
		truncateToWidth(`${theme.fg("success", item.sha)}${theme.fg("muted", ` • ${item.date} • ${item.author}`)}`, width, ""),
		width,
	);
}

const FG_RESET = "\u001b[39m";

function ensureForegroundReset(line: string): string {
	return line.endsWith(FG_RESET) ? line : `${line}${FG_RESET}`;
}

function highlightPreviewLine(line: string, theme: ExtensionCommandContext["ui"]["theme"]): string {
	if (line.startsWith("diff --git ")) return theme.fg("accent", theme.bold(line));
	if (line.startsWith("@@")) return theme.fg("warning", line);
	if (line.startsWith("+++ ") || line.startsWith("--- ")) return theme.fg("muted", line);
	if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
	if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
	if (line === "STAGED" || line === "UNSTAGED" || line === "UNTRACKED" || line === "WORKING TREE") {
		return theme.fg("accent", theme.bold(line));
	}
	return line;
}

function highlightPreviewText(text: string, theme: ExtensionCommandContext["ui"]["theme"]): string {
	return highlightCode(text, "diff")
		.map(ensureForegroundReset)
		.map((line) => highlightPreviewLine(line, theme))
		.join("\n");
}

export default function tiggyExtension(pi: ExtensionAPI) {
	async function run(ctx: ExtensionCommandContext, command: string, args: string[], timeout = 10_000): Promise<CommandResult> {
		const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout });
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.code,
		};
	}

	async function ensureRepo(ctx: ExtensionCommandContext): Promise<string | undefined> {
		const result = await run(ctx, "git", ["rev-parse", "--show-toplevel"]);
		if (result.code !== 0) {
			return formatCommandError(result);
		}
		return undefined;
	}

	async function loadItems(ctx: ExtensionCommandContext): Promise<TiggyData> {
		const repoError = await ensureRepo(ctx);
		if (repoError) {
			throw new Error(repoError);
		}

		const [statusResult, porcelainResult, logResult] = await Promise.all([
			run(ctx, "git", ["status", "--short", "--branch"], 30_000),
			run(ctx, "git", ["status", "--porcelain=v1"], 30_000),
			run(ctx, "git", ["log", "--date=short", "--format=%h%x09%ad%x09%an%x09%s"], 120_000),
		]);

		if (statusResult.code !== 0) throw new Error(formatCommandError(statusResult));
		if (porcelainResult.code !== 0) throw new Error(formatCommandError(porcelainResult));
		if (logResult.code !== 0) throw new Error(formatCommandError(logResult));

		const branchLabel = parseBranchLabel(statusResult.stdout);
		const dirtyCount = countNonEmptyLines(porcelainResult.stdout);
		const statusItem: StatusItem = {
			type: "status",
			key: "status",
			label: "working tree",
			description: dirtyCount === 0 ? "clean" : `${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`,
			branch: branchLabel,
			index: 0,
		};

		return {
			branchLabel,
			items: [statusItem, ...parseCommitItems(logResult.stdout, 1)],
		};
	}

	async function loadStatusPreview(ctx: ExtensionCommandContext): Promise<string> {
		const [statusResult, stagedResult, unstagedResult, untrackedResult] = await Promise.all([
			run(ctx, "git", ["status", "--short", "--branch"], 30_000),
			run(ctx, "git", ["diff", "--cached", "--stat", "--patch", "--no-ext-diff", "--color=never"], 30_000),
			run(ctx, "git", ["diff", "--stat", "--patch", "--no-ext-diff", "--color=never"], 30_000),
			run(ctx, "git", ["ls-files", "--others", "--exclude-standard"], 30_000),
		]);

		if (statusResult.code !== 0) throw new Error(formatCommandError(statusResult));
		if (stagedResult.code !== 0) throw new Error(formatCommandError(stagedResult));
		if (unstagedResult.code !== 0) throw new Error(formatCommandError(unstagedResult));
		if (untrackedResult.code !== 0) throw new Error(formatCommandError(untrackedResult));

		const sections: string[] = [];
		sections.push("WORKING TREE");
		sections.push(statusResult.stdout.trim() || "(clean)");
		sections.push("");
		sections.push("STAGED");
		sections.push(stagedResult.stdout.trim() || "(none)");
		sections.push("");
		sections.push("UNSTAGED");
		sections.push(unstagedResult.stdout.trim() || "(none)");

		const untracked = untrackedResult.stdout.trim();
		if (untracked) {
			sections.push("");
			sections.push("UNTRACKED");
			sections.push(untracked);
		}

		return sanitizePreviewText(sections.join("\n"));
	}

	async function loadCommitPreview(ctx: ExtensionCommandContext, sha: string): Promise<string> {
		const result = await run(
			ctx,
			"git",
			["show", "--stat", "--patch", "--format=fuller", "--no-ext-diff", "--color=never", sha],
			30_000,
		);
		if (result.code !== 0) {
			throw new Error(formatCommandError(result));
		}
		return sanitizePreviewText(result.stdout.trim() || `(empty commit ${sha})`);
	}

	async function loadPreview(ctx: ExtensionCommandContext, item: TiggyItem): Promise<string> {
		if (item.type === "status") return loadStatusPreview(ctx);
		return loadCommitPreview(ctx, item.sha);
	}

	async function openTiggy(
		ctx: ExtensionCommandContext,
		options: { openInitialPreview?: boolean } = {},
	): Promise<void> {
		const data = await loadItems(ctx);
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/tiggy is TUI-only", "warning");
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const { openInitialPreview = false } = options;
			let currentData = data;
			let selectedIndex = 0;
			let previewText = "Press Enter to preview.";
			let previewScroll = 0;
			let previewViewportRows = 1;
			let listViewportRows = 1;
			let loadingPreview = false;
			let loadingItems = false;
			let banner: string | undefined;
			let activeItemKey: string | undefined;
			let previewToken = 0;
			let wrappedPreviewWidth = 0;
			let wrappedPreviewText = "";
			let wrappedPreviewLines = [previewText];
			let highlightedPreviewWidth = 0;
			let highlightedPreviewText = "";
			let highlightedPreviewLines = [previewText];
			let searchActive = false;
			let searchBaseScroll = 0;
			let searchMatchLine: number | undefined;
			let lastSearchQuery = "";
			const previewCache = new Map<string, string>();
			const searchInput = new Input();
			searchInput.focused = false;

			const clampSelection = () => {
				selectedIndex = currentData.items.length === 0 ? 0 : Math.max(0, Math.min(selectedIndex, currentData.items.length - 1));
				return currentData.items;
			};
			const getSelected = () => {
				const items = clampSelection();
				return items[selectedIndex];
			};
			const getPreviewItem = () => currentData.items.find((item) => item.key === activeItemKey);
			const getWrappedPreviewLines = (width: number) => {
				if (wrappedPreviewWidth !== width || wrappedPreviewText !== previewText) {
					wrappedPreviewWidth = width;
					wrappedPreviewText = previewText;
					wrappedPreviewLines = wrapBlock(previewText, width);
				}
				return wrappedPreviewLines;
			};
			const getHighlightedPreviewLines = (width: number) => {
				if (highlightedPreviewWidth !== width || highlightedPreviewText !== previewText) {
					highlightedPreviewWidth = width;
					highlightedPreviewText = previewText;
					const sourceLines = highlightPreviewText(previewText, theme).split(/\r?\n/);
					highlightedPreviewLines = sourceLines.flatMap((line) => {
						const wrapped = wrapTextWithAnsi(line || " ", width);
						return wrapped.length === 0 ? [""] : wrapped;
					});
				}
				return highlightedPreviewLines;
			};
			const clearSearch = (restoreScroll = false, keepMatch = false) => {
				searchActive = false;
				searchInput.focused = false;
				searchInput.setValue("");
				if (!keepMatch) {
					searchMatchLine = undefined;
					lastSearchQuery = "";
				}
				if (restoreScroll) {
					previewScroll = searchBaseScroll;
				}
			};
			const updateSearch = (matches: number[]) => {
				if (!searchActive) {
					return;
				}
				const query = searchInput.getValue().trim();
				if (!query) {
					searchMatchLine = undefined;
					previewScroll = searchBaseScroll;
					return;
				}
				const nextMatch = matches.find((line) => line >= searchBaseScroll) ?? matches[0];
				if (nextMatch === undefined) {
					searchMatchLine = undefined;
					return;
				}
				searchMatchLine = nextMatch;
				previewScroll = Math.max(0, nextMatch - Math.floor(Math.max(1, previewViewportRows) / 3));
			};
			const openSearch = () => {
				searchActive = true;
				searchBaseScroll = previewScroll;
				searchInput.focused = true;
				searchInput.setValue("");
				searchMatchLine = undefined;
			};
			const getActiveSearchQuery = () => (searchActive ? searchInput.getValue() : lastSearchQuery).trim();
			const renderSearchInputLine = (width: number) => {
				const rawSearchLine = searchInput.render(Math.max(1, width - 1))[0] ?? "";
				const inputLine = rawSearchLine.startsWith("> ") ? rawSearchLine.slice(2) : rawSearchLine;
				return padLine(`${theme.fg("accent", "/ ")}${inputLine}`, width);
			};
			const renderSearchMatchStatusLine = (width: number, currentMatchIndex: number, matchCount: number) => {
				if (matchCount === 0) return padLine(theme.fg("warning", "no matches"), width);
				const current = currentMatchIndex >= 0 ? currentMatchIndex + 1 : 1;
				return padLine(theme.fg("dim", `${current}/${matchCount} match${matchCount === 1 ? "" : "es"}`), width);
			};
			const getSearchModeActive = () => !searchActive && lastSearchQuery !== "";
			const getPreviewWidth = () => {
				const width = Math.max(1, tui.terminal.columns);
				if (width < 40) return width;
				const availableWidth = Math.max(2, width - visibleWidth("│"));
				const leftWidth = Math.floor(availableWidth / 2);
				return Math.max(1, availableWidth - leftWidth);
			};
			const jumpSearchMatch = (direction: 1 | -1) => {
				const query = (searchActive ? searchInput.getValue() : lastSearchQuery).trim();
				if (!query) return;
				const matches = findMatchingLineIndexes(getWrappedPreviewLines(getPreviewWidth()), query);
				if (matches.length === 0) {
					searchMatchLine = undefined;
					return;
				}
				const currentLine = searchMatchLine ?? previewScroll;
				const nextMatch =
					direction > 0
						? matches.find((line) => line > currentLine) ?? matches[0]
						: [...matches].reverse().find((line) => line < currentLine) ?? matches[matches.length - 1];
				if (nextMatch === undefined) return;
				searchMatchLine = nextMatch;
				lastSearchQuery = query;
				previewScroll = Math.max(0, nextMatch - Math.floor(Math.max(1, previewViewportRows) / 3));
			};
			const clearPreview = (message = "Press Enter to preview.") => {
				clearSearch();
				activeItemKey = undefined;
				loadingPreview = false;
				previewScroll = 0;
				previewText = message;
			};

			const requestPreview = (item = getSelected()) => {
				clearSearch();
				previewScroll = 0;

				if (!item) {
					clearPreview("No items.");
					tui.requestRender();
					return;
				}

				activeItemKey = item.key;
				const cached = previewCache.get(item.key);
				if (cached !== undefined) {
					loadingPreview = false;
					previewText = cached;
					tui.requestRender();
					return;
				}

				loadingPreview = true;
				previewText = item.type === "status" ? "Loading working tree..." : `Loading ${item.sha}...`;
				const token = ++previewToken;
				void loadPreview(ctx, item)
					.then((text) => {
						previewCache.set(item.key, text);
						if (token !== previewToken || activeItemKey !== item.key) return;
						loadingPreview = false;
						previewText = text;
						tui.requestRender();
					})
					.catch((error: unknown) => {
						if (token !== previewToken || activeItemKey !== item.key) return;
						loadingPreview = false;
						previewText = error instanceof Error ? error.message : String(error);
						tui.requestRender();
					});
				tui.requestRender();
			};

			const refresh = () => {
				const currentKey = getSelected()?.key;
				const previewKey = activeItemKey;
				clearSearch();
				loadingItems = true;
				banner = undefined;
				previewCache.clear();
				previewText = "Reloading...";
				tui.requestRender();

				void loadItems(ctx)
					.then((nextData) => {
						currentData = nextData;
						loadingItems = false;
						selectedIndex = currentKey ? Math.max(0, currentData.items.findIndex((item) => item.key === currentKey)) : 0;
						const previewItem = previewKey ? currentData.items.find((item) => item.key === previewKey) : undefined;
						if (previewItem) {
							requestPreview(previewItem);
							return;
						}
						clearPreview();
						tui.requestRender();
					})
					.catch((error: unknown) => {
						loadingItems = false;
						banner = error instanceof Error ? error.message : String(error);
						previewText = banner;
						tui.requestRender();
					});
			};

			if (openInitialPreview) {
				requestPreview(currentData.items[0]);
			}

			return {
				render(width: number) {
					const items = clampSelection();
					const previewItem = getPreviewItem();
					const totalRows = Math.max(12, tui.terminal.rows - 1);
					const narrowLayout = width < 40;
					const divider = theme.fg("borderMuted", "│");
					const availableWidth = Math.max(2, width - visibleWidth(divider));
					const leftWidth = narrowLayout ? width : Math.floor(availableWidth / 2);
					const previewWidth = narrowLayout ? width : Math.max(1, availableWidth - leftWidth);
					const previewLines = getWrappedPreviewLines(previewWidth);
					const previewDisplayLines = getHighlightedPreviewLines(previewWidth);
					const searchQuery = getActiveSearchQuery();
					const searchModeActive = getSearchModeActive();
					const searchMatches = searchQuery ? findMatchingLineIndexes(previewLines, searchQuery) : [];
					const currentMatchIndex = searchMatchLine === undefined ? -1 : searchMatches.findIndex((line) => line === searchMatchLine);
					const searchStatus = searchQuery
						? searchMatches.length === 0
							? theme.fg("warning", " • no matches")
							: theme.fg("dim", ` • ${currentMatchIndex >= 0 ? `${currentMatchIndex + 1}/` : ""}${searchMatches.length} match${searchMatches.length === 1 ? "" : "es"}`)
						: "";
					const title = renderInlineLine(
						width,
						` ${theme.fg("accent", theme.bold("tiggy"))}${theme.fg("muted", ` • ${truncateToWidth(currentData.branchLabel, Math.max(1, width - 12), "")}`)}`,
					);
					const help = searchActive
						? theme.fg("dim", "type to search • enter search mode • esc/Ctrl+C cancel")
						: searchModeActive
							? theme.fg("dim", "n next match • / new search • esc/Ctrl+C clear search • q close preview")
							: activeItemKey
								? theme.fg("dim", "j/k or ↑↓ scroll preview • / search • q close preview • PgUp/PgDn scroll • Ctrl+R reload • Esc close")
								: theme.fg("dim", "j/k or ↑↓ select • enter preview • Ctrl+U/Ctrl+D jump • PgUp/PgDn scroll • Ctrl+R reload • Esc close");
					const status = `${theme.fg(
						loadingItems ? "warning" : loadingPreview ? "warning" : "dim",
						loadingItems ? "reloading…" : loadingPreview ? "loading…" : `${items.length} items`,
					)}${searchStatus}`;
					const lines = [theme.fg("accent", "─".repeat(width)), title, renderInlineLine(width, ` ${status}`)];

					if (banner) {
						lines.push(` ${theme.fg("warning", truncateToWidth(banner, Math.max(1, width - 1), ""))}`);
					}

					let previewLineCount = previewLines.length;

					if (narrowLayout) {
						const contentRows = Math.max(4, totalRows - (banner ? 10 : 9));
						const listVisibleRows = Math.min(Math.max(3, Math.min(8, items.length || 1)), Math.max(1, contentRows - 2));
						const searchRows = searchActive || searchModeActive ? 1 : 0;
						listViewportRows = listVisibleRows;
						previewViewportRows = Math.max(1, contentRows - listVisibleRows - 2 - searchRows);
						updateSearch(searchMatches);
						previewScroll = Math.max(0, Math.min(previewScroll, Math.max(0, previewLines.length - previewViewportRows)));
						const listStart = Math.max(0, Math.min(selectedIndex - Math.floor(listVisibleRows / 2), Math.max(0, items.length - listVisibleRows)));
						const visibleItems = items.slice(listStart, listStart + listVisibleRows);

						for (let row = 0; row < listVisibleRows; row++) {
							const item = visibleItems[row];
							const absoluteIndex = listStart + row;
							lines.push(item ? renderListRow(item, absoluteIndex === selectedIndex, width, theme, Boolean(activeItemKey)) : " ".repeat(width));
						}

						lines.push("");
						lines.push(renderPreviewHeader(previewItem, width, theme));
						for (let row = 0; row < previewViewportRows; row++) {
							const lineIndex = previewScroll + row;
							const line = padLine(previewDisplayLines[lineIndex] ?? "", width);
							lines.push(searchMatchLine === lineIndex ? theme.bg("selectedBg", line) : line);
						}
						if (searchActive) {
							lines.push(renderSearchInputLine(width));
						} else if (searchModeActive) {
							lines.push(renderSearchMatchStatusLine(width, currentMatchIndex, searchMatches.length));
						}
					} else {
						const contentRows = Math.max(4, totalRows - (banner ? 8 : 7));
						const searchRows = searchActive || searchModeActive ? 1 : 0;
						const rightWidth = previewWidth;
						listViewportRows = contentRows;
						previewViewportRows = Math.max(1, contentRows - searchRows);
						updateSearch(searchMatches);
						previewScroll = Math.max(0, Math.min(previewScroll, Math.max(0, previewLines.length - previewViewportRows)));
						const listStart = Math.max(0, Math.min(selectedIndex - Math.floor(contentRows / 2), Math.max(0, items.length - contentRows)));
						const visibleItems = items.slice(listStart, listStart + contentRows);

						lines.push(`${" ".repeat(leftWidth)}${divider}${renderPreviewHeader(previewItem, rightWidth, theme)}`);

						for (let row = 0; row < contentRows; row++) {
							const item = visibleItems[row];
							const absoluteIndex = listStart + row;
							const left = item
								? renderListRow(item, absoluteIndex === selectedIndex, leftWidth, theme, Boolean(activeItemKey))
								: " ".repeat(leftWidth);
							const isSearchRow = (searchActive || searchModeActive) && row === contentRows - 1;
							const right = isSearchRow
								? searchActive
									? renderSearchInputLine(rightWidth)
									: renderSearchMatchStatusLine(rightWidth, currentMatchIndex, searchMatches.length)
								: (() => {
									const lineIndex = previewScroll + row;
									const rightLine = padLine(previewDisplayLines[lineIndex] ?? "", rightWidth);
									return searchMatchLine === lineIndex ? theme.bg("selectedBg", rightLine) : rightLine;
								})();
							lines.push(`${left}${divider}${right}`);
						}
					}

					lines.push("");
					const previewStatus = activeItemKey
						? theme.fg("dim", ` • preview ${previewScroll + 1}-${Math.min(previewLineCount, previewScroll + previewViewportRows)}/${previewLineCount}`)
						: "";
					lines.push(renderInlineLine(width, ` ${help}${previewStatus}`));
					lines.push(theme.fg("accent", "─".repeat(width)));
					return lines.map((line) => truncateToWidth(line, width, ""));
				},
				invalidate() {
					searchInput.invalidate();
				},
				handleInput(data: string) {
					const items = clampSelection();

					if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
						if (searchActive) {
							clearSearch(true);
							tui.requestRender();
							return;
						}
						if (getSearchModeActive()) {
							clearSearch();
							tui.requestRender();
							return;
						}
						done(undefined);
						return;
					}

					if (matchesKey(data, Key.ctrl("r"))) {
						refresh();
						return;
					}

					if (searchActive) {
						if (matchesKey(data, Key.enter)) {
							const query = searchInput.getValue().trim();
							if (!query) {
								clearSearch();
								tui.requestRender();
								return;
							}
							lastSearchQuery = query;
							clearSearch(false, true);
							tui.requestRender();
							return;
						}
						searchInput.handleInput(data);
						tui.requestRender();
						return;
					}

					if (data === "q") {
						if (activeItemKey) {
							clearPreview();
							tui.requestRender();
							return;
						}
						done(undefined);
						return;
					}

					if (activeItemKey) {
						if (data === "/") {
							openSearch();
							tui.requestRender();
							return;
						}

						if (data === "n") {
							jumpSearchMatch(1);
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.up) || data === "k") {
							previewScroll = Math.max(0, previewScroll - 1);
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.down) || data === "j") {
							previewScroll += 1;
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.home) || data === "g") {
							previewScroll = 0;
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.end) || data === "G") {
							previewScroll = Number.MAX_SAFE_INTEGER;
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.enter)) {
							return;
						}

						if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("d"))) {
							const step = Math.max(1, Math.floor(previewViewportRows / 2));
							previewScroll = matchesKey(data, Key.ctrl("u"))
								? Math.max(0, previewScroll - step)
								: previewScroll + step;
							tui.requestRender();
							return;
						}
					} else {
						if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === "k" || data === "j") {
							if (items.length > 0) {
								const moveUp = matchesKey(data, Key.up) || data === "k";
								selectedIndex = moveUp
									? Math.max(0, selectedIndex - 1)
									: Math.min(items.length - 1, selectedIndex + 1);
							}
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.home) || data === "g") {
							selectedIndex = 0;
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.end) || data === "G") {
							selectedIndex = Math.max(0, items.length - 1);
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.enter)) {
							requestPreview();
							return;
						}

						if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("d"))) {
							if (items.length > 0) {
								const step = Math.max(1, Math.floor(listViewportRows / 2));
								selectedIndex = matchesKey(data, Key.ctrl("u"))
									? Math.max(0, selectedIndex - step)
									: Math.min(items.length - 1, selectedIndex + step);
							}
							tui.requestRender();
							return;
						}
					}

					if (matchesKey(data, Key.pageUp)) {
						previewScroll = Math.max(0, previewScroll - Math.max(1, previewViewportRows));
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.pageDown)) {
						previewScroll += Math.max(1, previewViewportRows);
						tui.requestRender();
						return;
					}
				},
			};
		});
	}

	pi.registerCommand("tiggy", {
		description: "Browse git history and diffs",
		handler: async (_args, ctx) => {
			try {
				await openTiggy(ctx);
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("diff", {
		description: "Open tiggy with the working tree diff previewed",
		handler: async (_args, ctx) => {
			try {
				await openTiggy(ctx, { openInitialPreview: true });
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
