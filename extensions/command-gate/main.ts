import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import seedConfig from "./seed.json";
import {
	addGlobalRuleDisable,
	addProjectRuleDisable,
	createCommandGatePaths,
	findMatchingRule,
	formatRulesReport,
	getEffectiveRulesFromState,
	isWithinDirectory,
	loadGlobalState,
	loadProjectState,
	loadRules,
	makeRuleId,
	normalizeGlobalState,
	nowIso,
	parseSeedRules,
	saveGlobalState,
	saveProjectState,
	saveRules,
	type DisableScope,
	type GlobalState,
	type RuleAction,
} from "./core.ts";

const PROJECT_ROOT = process.cwd();
const PATHS = createCommandGatePaths(PROJECT_ROOT, homedir());
const SEED_RULES = parseSeedRules(seedConfig, "extensions/command-gate/seed.json");
const SESSION_STATE_TYPE = "command-gate-session-state";

function getProjectStatePath(): string {
	return PATHS.projectStatePath;
}

function getSessionState(ctx: ExtensionContext): GlobalState {
	const entries = ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
	let state: GlobalState = { disabledRuleIds: [] };
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === SESSION_STATE_TYPE) {
			state = normalizeGlobalState(entry.data);
		}
	}
	return state;
}

function getEffectiveRules(ctx: ExtensionContext) {
	return getEffectiveRulesFromState({
		config: loadRules(PATHS, SEED_RULES),
		globalState: loadGlobalState(PATHS.globalStatePath),
		projectState: loadProjectState(PATHS.projectStatePath),
		sessionState: getSessionState(ctx),
		cwd: ctx.cwd,
		projectRoot: PROJECT_ROOT,
	});
}

function textResult(text: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

const listRulesTool = defineTool({
	name: "command_gate_list_rules",
	label: "Command gate: list rules",
	description: `List effective bash command-gate rules and overrides. Use before adding duplicates or disabling a rule.`,
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	} as any,
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const rules = getEffectiveRules(ctx);
		return textResult(
			formatRulesReport({
				rules,
				paths: PATHS,
				cwd: ctx.cwd,
			}),
			{
				paths: {
					rules: PATHS.globalRulesPath,
					globalState: PATHS.globalStatePath,
					projectState: getProjectStatePath(),
					sessionState: SESSION_STATE_TYPE,
				},
				ruleCount: rules.length,
			},
		);
	},
});

const addRuleTool = defineTool({
	name: "command_gate_add_rule",
	label: "Command gate: add rule",
	description: `Add a global bash command-gate rule to ${PATHS.globalRulesPath}. Use this instead of editing command-gate files directly.`,
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["block", "confirm"],
				description: "What to do when the pattern matches",
			},
			pattern: {
				type: "string",
				description: "JavaScript regex pattern to match against the bash command",
			},
			reason: {
				type: "string",
				description: "Short human-readable reason shown when the rule matches",
			},
			id: {
				type: "string",
				description: "Optional stable rule id. Leave empty to auto-generate one",
			},
		},
		required: ["action", "pattern"],
		additionalProperties: false,
	} as any,
	async execute(_toolCallId, params: { action: RuleAction; pattern: string; reason?: string; id?: string }) {
		new RegExp(params.pattern, "i");
		const config = loadRules(PATHS, SEED_RULES);
		const existingIds = new Set(config.bash.map((rule) => rule.id));
		const id = params.id?.trim() || makeRuleId(params.pattern, existingIds);
		if (existingIds.has(id)) {
			throw new Error(`Rule already exists: ${id}`);
		}

		const rule = {
			id,
			enabled: true,
			action: params.action,
			pattern: params.pattern,
			...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
			createdAt: nowIso(),
		};
		config.bash.push(rule);
		saveRules(PATHS.globalRulesPath, config);
		return textResult(`Added global rule ${id}`, { rule, path: PATHS.globalRulesPath });
	},
});

function createDisableRuleTool(pi: ExtensionAPI) {
	return defineTool({
		name: "command_gate_disable_rule",
		label: "Command gate: disable rule",
		description:
			"Disable a command-gate rule for the current session, current project, or globally. Project disables can optionally be limited to a directory subtree. Every disable requires explicit user confirmation.",
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Rule id to disable",
				},
				scope: {
					type: "string",
					enum: ["session", "project", "global"],
					description: "Where to disable the rule. Defaults to session.",
				},
				directory: {
					type: "string",
					description: "Optional directory path for project scope. Relative paths are resolved from the current working directory.",
				},
			},
			required: ["id"],
			additionalProperties: false,
		} as any,
		async execute(
			_toolCallId,
			params: { id: string; scope?: DisableScope; directory?: string },
			_signal,
			_onUpdate,
			ctx,
		) {
			const scope = params.scope ?? "session";
			const directory = params.directory?.trim();
			const ruleInfo = getEffectiveRules(ctx).find((entry) => entry.rule.id === params.id);
			if (!ruleInfo) {
				throw new Error(`Rule not found: ${params.id}`);
			}
			if (!ctx.hasUI) {
				throw new Error(`Disabling rules requires user confirmation in UI: ${params.id}`);
			}
			if (scope !== "project" && directory) {
				throw new Error("directory can only be used with scope=project");
			}

			const projectDirectory = directory ? resolve(ctx.cwd, directory) : PROJECT_ROOT;
			if (scope === "project" && !isWithinDirectory(PROJECT_ROOT, projectDirectory)) {
				throw new Error(`Project directory must stay inside project root: ${projectDirectory}`);
			}

			const target =
				scope === "session"
					? "this session"
					: scope === "global"
						? PATHS.globalStatePath
						: `${PATHS.projectStatePath}#${projectDirectory}`;
			const ok = await ctx.ui.confirm(
				`Disable command-gate rule ${params.id} for ${scope}?`,
				`${ruleInfo.rule.reason ?? "No reason provided."}\n\n${ruleInfo.rule.pattern}\n\nTarget: ${target}`,
			);
			if (!ok) {
				throw new Error(`Rule disable cancelled by user: ${params.id}`);
			}

			if (scope === "session") {
				const state = getSessionState(ctx);
				if (!addGlobalRuleDisable(state, params.id)) {
					return textResult(`Rule ${params.id} is already disabled for this session`, {
						scope,
						id: params.id,
					});
				}
				pi.appendEntry(SESSION_STATE_TYPE, state);
				return textResult(`Disabled rule ${params.id} for this session`, {
					scope,
					id: params.id,
				});
			}

			if (scope === "global") {
				const state = loadGlobalState(PATHS.globalStatePath);
				if (!addGlobalRuleDisable(state, params.id)) {
					return textResult(`Rule ${params.id} is already disabled for ${scope}`, {
						scope,
						id: params.id,
						path: PATHS.globalStatePath,
					});
				}
				saveGlobalState(PATHS.globalStatePath, state);
				return textResult(`Disabled rule ${params.id} for ${scope}`, {
					scope,
					id: params.id,
					path: PATHS.globalStatePath,
				});
			}

			const state = loadProjectState(PATHS.projectStatePath);
			if (!addProjectRuleDisable(state, projectDirectory, params.id)) {
				return textResult(`Rule ${params.id} is already disabled for ${scope}`, {
					scope,
					id: params.id,
					path: PATHS.projectStatePath,
					directory: projectDirectory,
				});
			}
			saveProjectState(PATHS.projectStatePath, state);
			return textResult(`Disabled rule ${params.id} for ${scope}`, {
				scope,
				id: params.id,
				path: PATHS.projectStatePath,
				directory: projectDirectory,
			});
		},
	});
}

export default function commandGateExtension(pi: ExtensionAPI) {
	pi.registerTool(listRulesTool);
	pi.registerTool(addRuleTool);
	pi.registerTool(createDisableRuleTool(pi));

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String(event.input.command ?? "");
		const matchedRule = findMatchingRule(command, getEffectiveRules(ctx));
		if (!matchedRule) return undefined;

		if (matchedRule.action === "block") {
			return {
				block: true,
				reason: matchedRule.reason ?? `Blocked by command-gate rule ${matchedRule.id}`,
			};
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: matchedRule.reason ?? `Confirmation required by command-gate rule ${matchedRule.id}`,
			};
		}

		const ok = await ctx.ui.confirm(matchedRule.reason ?? `Allow command for rule ${matchedRule.id}?`, command);
		if (!ok) {
			return {
				block: true,
				reason: `Blocked by user (${matchedRule.id})`,
			};
		}

		return undefined;
	});
}
