import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createCommandGatePaths,
	ensureRulesFile,
	findMatchingRule,
	getEffectiveRulesFromState,
	getProjectDirectoryKeys,
	makeRuleId,
	normalizeDirectoryRuleMap,
	normalizeIdList,
	parseSeedRules,
	type CommandGateRule,
} from "../extensions/command-gate/core.ts";
import seedConfig from "../extensions/command-gate/seed.json";

function makeRule(overrides: Partial<CommandGateRule> & Pick<CommandGateRule, "id" | "action" | "pattern">): CommandGateRule {
	return {
		enabled: true,
		...overrides,
	};
}

describe("command-gate core", () => {
	it("normalizes id lists and directory rule maps", () => {
		expect(normalizeIdList(["rule-a", "", "rule-a", 123, "rule-b"])).toEqual(["rule-a", "rule-b"]);
		expect(
			normalizeDirectoryRuleMap({
				"/repo": ["rule-a", "rule-a", ""],
				"": ["ignored"],
				"/repo/packages": ["rule-b"],
			}),
		).toEqual({
			"/repo": ["rule-a"],
			"/repo/packages": ["rule-b"],
		});
	});

	it("builds stable rule ids and adds a numeric suffix when needed", () => {
		expect(makeRuleId("Git Push --force", new Set())).toBe("git-push-force");
		expect(makeRuleId("Git Push --force", new Set(["git-push-force"]))).toBe("git-push-force-2");
		expect(makeRuleId("***", new Set())).toBe("rule");
	});

	it("returns project directory keys from root to the current directory", () => {
		const projectRoot = resolve("/repo");
		const cwd = resolve("/repo/packages/app");
		expect(getProjectDirectoryKeys(projectRoot, cwd)).toEqual([
			projectRoot,
			resolve("/repo/packages"),
			resolve("/repo/packages/app"),
		]);
		expect(getProjectDirectoryKeys(projectRoot, resolve("/outside"))).toEqual([]);
	});

	it("calculates effective rules from global, project, session, and config state", () => {
		const projectRoot = resolve("/repo");
		const cwd = resolve("/repo/packages/app");
		const rules = getEffectiveRulesFromState({
			config: {
				bash: [
					makeRule({ id: "global-off", action: "block", pattern: "git push" }),
					makeRule({ id: "project-off", action: "confirm", pattern: "git reset" }),
					makeRule({ id: "session-off", action: "confirm", pattern: "git clean" }),
					makeRule({ id: "config-off", action: "block", pattern: "rm -rf", enabled: false }),
					makeRule({ id: "active", action: "confirm", pattern: "git status" }),
				],
			},
			globalState: { disabledRuleIds: ["global-off"] },
			projectState: {
				disabledRuleIdsByDirectory: {
					[resolve("/repo/packages")]: ["project-off"],
				},
			},
			sessionState: { disabledRuleIds: ["session-off"] },
			cwd,
			projectRoot,
		});
		const byId = new Map(rules.map((ruleInfo) => [ruleInfo.rule.id, ruleInfo]));

		expect(byId.get("global-off")).toMatchObject({ effectiveEnabled: false, disabledBy: ["global"] });
		expect(byId.get("project-off")).toMatchObject({ effectiveEnabled: false, disabledBy: ["project"] });
		expect(byId.get("session-off")).toMatchObject({ effectiveEnabled: false, disabledBy: ["session"] });
		expect(byId.get("config-off")).toMatchObject({ effectiveEnabled: false, disabledInConfig: true });
		expect(byId.get("active")).toMatchObject({ effectiveEnabled: true, disabledBy: [], disabledInConfig: false });
	});

	it("finds the first enabled matching rule and ignores invalid regex patterns", () => {
		const rules = getEffectiveRulesFromState({
			config: {
				bash: [
					makeRule({ id: "disabled-match", action: "block", pattern: "git push" }),
					makeRule({ id: "invalid-regex", action: "block", pattern: "[" }),
					makeRule({ id: "active-match", action: "confirm", pattern: "git\\s+push" }),
				],
			},
			globalState: { disabledRuleIds: ["disabled-match"] },
			projectState: { disabledRuleIdsByDirectory: {} },
			sessionState: { disabledRuleIds: [] },
			cwd: resolve("/repo"),
			projectRoot: resolve("/repo"),
		});

		expect(findMatchingRule("git push origin main", rules)?.id).toBe("active-match");
		expect(findMatchingRule("echo hello", rules)).toBeUndefined();
	});

	it("parses the bundled seed config", () => {
		const seedRules = parseSeedRules(seedConfig, "test-seed");
		expect(seedRules.length).toBeGreaterThan(0);
		expect(seedRules[0]).toMatchObject({
			id: expect.any(String),
			action: expect.stringMatching(/^(block|confirm)$/),
			pattern: expect.any(String),
		});
	});

	it("seeds the global rules file from bundled rules when it does not exist", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "command-gate-project-"));
		const homeDir = mkdtempSync(join(tmpdir(), "command-gate-home-"));
		const seedRules = parseSeedRules(seedConfig, "test-seed");

		const paths = createCommandGatePaths(projectRoot, homeDir);
		const config = ensureRulesFile(paths, seedRules);
		const persisted = JSON.parse(readFileSync(paths.globalRulesPath, "utf8")) as { bash: Array<{ id: string }> };

		expect(config.bash.map((rule) => rule.id)).toEqual(seedRules.map((rule) => rule.id));
		expect(persisted.bash.map((rule) => rule.id)).toEqual(seedRules.map((rule) => rule.id));
	});
});
