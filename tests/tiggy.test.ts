import { describe, expect, it } from "vitest";
import {
	countNonEmptyLines,
	findMatchingLineIndexes,
	formatCommandError,
	parseBranchLabel,
	parseCommitItems,
	sanitizePreviewText,
	wrapBlock,
} from "../extensions/tiggy/core";

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
