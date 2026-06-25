import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type TiggyItem = StatusItem | CommitItem;

export interface StatusItem {
	type: "status";
	key: string;
	label: string;
	description: string;
	branch: string;
	index: number;
}

export interface CommitItem {
	type: "commit";
	key: string;
	sha: string;
	date: string;
	author: string;
	subject: string;
	label: string;
	description: string;
	index: number;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface TiggyData {
	branchLabel: string;
	items: TiggyItem[];
}

export function formatCommandError(result: CommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `command exited with code ${result.code}`;
}

export function countNonEmptyLines(text: string): number {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean).length;
}

export function parseBranchLabel(statusOutput: string): string {
	const firstLine = statusOutput.split(/\r?\n/)[0]?.trim() ?? "";
	return firstLine.replace(/^##\s*/, "") || "git";
}

export function parseCommitItems(stdout: string, startIndex: number): CommitItem[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			const [sha = "", date = "", author = "", ...subjectParts] = line.split("\t");
			const subject = subjectParts.join("\t") || "(no subject)";
			return {
				type: "commit",
				key: `commit:${sha}`,
				sha,
				date,
				author,
				subject,
				label: `${sha} ${subject}`,
				description: `${date} • ${author}`,
				index: startIndex + index,
			} satisfies CommitItem;
		})
		.filter((item) => item.sha !== "");
}

export function padLine(text: string, width: number): string {
	const line = truncateToWidth(text, width, "");
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

export function sanitizePreviewText(text: string): string {
	return text
		.replace(/\t/g, "    ")
		.replace(/\u001b/g, "^[")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "?");
}

export function wrapBlock(text: string, width: number): string[] {
	if (width <= 0) return [""];
	const sourceLines = text.length === 0 ? [""] : sanitizePreviewText(text).split(/\r?\n/);
	const wrapped = sourceLines.flatMap((line) => {
		const lines = wrapTextWithAnsi(line || " ", width);
		return lines.length === 0 ? [""] : lines;
	});
	return wrapped.length === 0 ? [""] : wrapped;
}

export function findMatchingLineIndexes(lines: string[], query: string): number[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) return [];
	const matches: number[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line?.toLocaleLowerCase().includes(normalizedQuery)) {
			matches.push(index);
		}
	}
	return matches;
}
