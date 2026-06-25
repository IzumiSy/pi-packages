import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type RuleAction = "block" | "confirm";
type DisableScope = "session" | "project" | "global";

interface CommandGateRule {
	id: string;
	enabled: boolean;
	action: RuleAction;
	pattern: string;
	reason?: string;
	createdAt?: string;
	disabledAt?: string;
}

interface CommandGateConfig {
	bash: CommandGateRule[];
}

interface GlobalState {
	disabledRuleIds: string[];
}

interface ProjectState {
	disabledRuleIdsByDirectory: Record<string, string[]>;
}

interface EffectiveRule {
	rule: CommandGateRule;
	disabledInConfig: boolean;
	disabledBy: DisableScope[];
	effectiveEnabled: boolean;
}

const PROJECT_ROOT = process.cwd();
const GLOBAL_CONFIG_DIR = resolve(homedir(), ".pi", "agent", "command-gate");
const GLOBAL_RULES_PATH = resolve(GLOBAL_CONFIG_DIR, "global.json");
const GLOBAL_STATE_PATH = resolve(GLOBAL_CONFIG_DIR, "global-state.json");
const PROJECT_STATE_PATH = resolve(GLOBAL_CONFIG_DIR, "project-state.json");
const SESSION_STATE_TYPE = "command-gate-session-state";
const SEED_RULES_PATH = resolve(PROJECT_ROOT, "extensions", "command-gate", "seed.json");

function getProjectStatePath(): string {
	return PROJECT_STATE_PATH;
}

function nowIso(): string {
	return new Date().toISOString();
}

function cloneRule(rule: CommandGateRule): CommandGateRule {
	return { ...rule };
}

function loadJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function normalizeIdList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
}

function normalizeDirectoryRuleMap(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object") return {};
	const output: Record<string, string[]> = {};
	for (const [directory, ids] of Object.entries(value as Record<string, unknown>)) {
		if (typeof directory !== "string" || directory.trim() === "") continue;
		const normalizedIds = normalizeIdList(ids);
		if (normalizedIds.length === 0) continue;
		output[directory] = normalizedIds;
	}
	return output;
}

function normalizeGlobalState(value: unknown): GlobalState {
	if (!value || typeof value !== "object") return defaultGlobalState();
	const candidate = value as Partial<GlobalState>;
	return { disabledRuleIds: normalizeIdList(candidate.disabledRuleIds) };
}

function normalizeProjectState(value: unknown): ProjectState {
	if (!value || typeof value !== "object") return defaultProjectState();
	const candidate = value as Partial<ProjectState>;
	return {
		disabledRuleIdsByDirectory: normalizeDirectoryRuleMap(candidate.disabledRuleIdsByDirectory),
	};
}

function loadSeedRules(): CommandGateRule[] {
	const parsed = loadJson(SEED_RULES_PATH);
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`Invalid command-gate seed config: ${SEED_RULES_PATH}`);
	}

	const candidate = parsed as Partial<CommandGateConfig>;
	const rules = Array.isArray(candidate.bash)
		? candidate.bash.map(normalizeRule).filter((rule): rule is CommandGateRule => rule !== undefined)
		: [];
	if (rules.length === 0) {
		throw new Error(`Command-gate seed config has no valid rules: ${SEED_RULES_PATH}`);
	}
	return rules;
}

function defaultConfig(): CommandGateConfig {
	return { bash: loadSeedRules().map(cloneRule) };
}

function defaultGlobalState(): GlobalState {
	return { disabledRuleIds: [] };
}

function defaultProjectState(): ProjectState {
	return { disabledRuleIdsByDirectory: {} };
}

function normalizeRule(value: unknown): CommandGateRule | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rule = value as Partial<CommandGateRule>;
	if (typeof rule.id !== "string" || rule.id.trim() === "") return undefined;
	if (rule.action !== "block" && rule.action !== "confirm") return undefined;
	if (typeof rule.pattern !== "string" || rule.pattern.trim() === "") return undefined;

	return {
		id: rule.id.trim(),
		enabled: rule.enabled !== false,
		action: rule.action,
		pattern: rule.pattern,
		...(typeof rule.reason === "string" && rule.reason.trim() !== "" ? { reason: rule.reason.trim() } : {}),
		...(typeof rule.createdAt === "string" && rule.createdAt.trim() !== "" ? { createdAt: rule.createdAt } : {}),
		...(typeof rule.disabledAt === "string" && rule.disabledAt.trim() !== "" ? { disabledAt: rule.disabledAt } : {}),
	};
}

function normalizeConfig(value: unknown): CommandGateConfig {
	if (!value || typeof value !== "object") return defaultConfig();
	const candidate = value as Partial<CommandGateConfig>;
	const rules = Array.isArray(candidate.bash)
		? candidate.bash.map(normalizeRule).filter((rule): rule is CommandGateRule => rule !== undefined)
		: [];
	return {
		bash: rules.length === 0 ? loadSeedRules().map(cloneRule) : rules,
	};
}

function loadRulesFromPath(path: string): CommandGateConfig {
	return normalizeConfig(loadJson(path));
}

function saveRules(config: CommandGateConfig): void {
	mkdirSync(dirname(GLOBAL_RULES_PATH), { recursive: true });
	writeFileSync(GLOBAL_RULES_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function ensureRulesFile(): CommandGateConfig {
	if (existsSync(GLOBAL_RULES_PATH)) {
		return loadRulesFromPath(GLOBAL_RULES_PATH);
	}

	const config = defaultConfig();
	saveRules(config);
	return config;
}

function loadRules(): CommandGateConfig {
	return ensureRulesFile();
}

function saveGlobalState(state: GlobalState): void {
	mkdirSync(dirname(GLOBAL_STATE_PATH), { recursive: true });
	writeFileSync(GLOBAL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function saveProjectState(state: ProjectState): void {
	mkdirSync(dirname(PROJECT_STATE_PATH), { recursive: true });
	writeFileSync(PROJECT_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function addDisabledRuleIds(target: string[], ids: string[]): boolean {
	let changed = false;
	for (const id of ids) {
		if (target.includes(id)) continue;
		target.push(id);
		changed = true;
	}
	return changed;
}

function addDirectoryDisabledRuleIds(target: Record<string, string[]>, directory: string, ids: string[]): boolean {
	if (typeof directory !== "string" || directory.trim() === "" || ids.length === 0) return false;
	const current = target[directory] ?? [];
	const next = [...current];
	const changed = addDisabledRuleIds(next, ids);
	if (!changed) return false;
	target[directory] = next;
	return true;
}

function isWithinDirectory(root: string, target: string): boolean {
	const relPath = relative(root, target);
	return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

function loadGlobalState(): GlobalState {
	if (!existsSync(GLOBAL_STATE_PATH)) return defaultGlobalState();
	return normalizeGlobalState(loadJson(GLOBAL_STATE_PATH));
}

function loadProjectState(): ProjectState {
	if (!existsSync(PROJECT_STATE_PATH)) return defaultProjectState();
	return normalizeProjectState(loadJson(PROJECT_STATE_PATH));
}

function getSessionState(ctx: ExtensionContext): GlobalState {
	const entries = ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
	let state = defaultGlobalState();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === SESSION_STATE_TYPE) {
			state = normalizeGlobalState(entry.data);
		}
	}
	return state;
}

function getProjectDirectoryKeys(cwd: string): string[] {
	const resolvedCwd = resolve(cwd);
	if (!isWithinDirectory(PROJECT_ROOT, resolvedCwd)) return [];
	const relPath = relative(PROJECT_ROOT, resolvedCwd);
	if (relPath === "") return [PROJECT_ROOT];
	const segments = relPath.split(/[\\/]+/).filter(Boolean);
	return [PROJECT_ROOT, ...segments.map((_segment, index) => resolve(PROJECT_ROOT, ...segments.slice(0, index + 1)))];
}

function makeRuleId(pattern: string, existingIds: Set<string>): string {
	const slug = pattern
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const base = slug || "rule";
	let candidate = base;
	let suffix = 2;
	while (existingIds.has(candidate)) {
		candidate = `${base}-${suffix}`;
		suffix += 1;
	}
	return candidate;
}

function formatScopeList(scopes: DisableScope[]): string {
	return scopes.join(", ");
}

function formatRule(ruleInfo: EffectiveRule): string {
	const { rule } = ruleInfo;
	const reason = rule.reason ? ` — ${rule.reason}` : "";
	const effectiveState = ruleInfo.disabledInConfig
		? "disabled in global rules file"
		: ruleInfo.effectiveEnabled
			? "enabled"
			: `disabled by ${formatScopeList(ruleInfo.disabledBy)}`;
	return [
		`- ${rule.id} [${rule.action}]${reason}`,
		`  pattern: ${rule.pattern}`,
		`  effective: ${effectiveState}`,
	].join("\n");
}

function formatRulesReport(ctx: ExtensionContext, rules: EffectiveRule[]): string {
	const lines = [
		`Rules file: ${GLOBAL_RULES_PATH}`,
		`Global overrides: ${GLOBAL_STATE_PATH}`,
		`Project overrides: ${getProjectStatePath()}`,
		`Project root: ${PROJECT_ROOT}`,
		`Current directory: ${ctx.cwd}`,
		"Session overrides: current session branch",
		"",
	];

	if (rules.length === 0) {
		lines.push("No rules configured.");
		return lines.join("\n");
	}

	lines.push(...rules.map(formatRule));
	return lines.join("\n");
}


function hasGlobalRuleDisabled(id: string, state: GlobalState): boolean {
	return state.disabledRuleIds.includes(id);
}

function hasProjectRuleDisabled(id: string, state: ProjectState, directoryKeys: string[]): boolean {
	return directoryKeys.some((directory) => state.disabledRuleIdsByDirectory[directory]?.includes(id) === true);
}

function addGlobalRuleDisable(state: GlobalState, id: string): boolean {
	if (state.disabledRuleIds.includes(id)) return false;
	state.disabledRuleIds.push(id);
	return true;
}

function addProjectRuleDisable(state: ProjectState, directory: string, id: string): boolean {
	return addDirectoryDisabledRuleIds(state.disabledRuleIdsByDirectory, directory, [id]);
}

function getEffectiveRules(ctx: ExtensionContext): EffectiveRule[] {
	const rules = ensureRulesFile();
	const globalState = loadGlobalState();
	const projectState = loadProjectState();
	const sessionState = getSessionState(ctx);
	const projectDirectoryKeys = getProjectDirectoryKeys(ctx.cwd);

	return rules.bash.map((rule) => {
		const disabledBy: DisableScope[] = [];
		if (hasGlobalRuleDisabled(rule.id, globalState)) disabledBy.push("global");
		if (hasProjectRuleDisabled(rule.id, projectState, projectDirectoryKeys)) disabledBy.push("project");
		if (hasGlobalRuleDisabled(rule.id, sessionState)) disabledBy.push("session");
		const disabledInConfig = !rule.enabled;
		return {
			rule,
			disabledInConfig,
			disabledBy,
			effectiveEnabled: !disabledInConfig && disabledBy.length === 0,
		};
	});
}

function findMatchingRule(command: string, rules: EffectiveRule[]): CommandGateRule | undefined {
	for (const ruleInfo of rules) {
		if (!ruleInfo.effectiveEnabled) continue;
		try {
			if (new RegExp(ruleInfo.rule.pattern, "i").test(command)) {
				return ruleInfo.rule;
			}
		} catch {
			continue;
		}
	}
	return undefined;
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
		return textResult(formatRulesReport(ctx, rules), {
			paths: {
				rules: GLOBAL_RULES_PATH,
				globalState: GLOBAL_STATE_PATH,
				projectState: getProjectStatePath(),
				sessionState: SESSION_STATE_TYPE,
			},
			ruleCount: rules.length,
		});
	},
});

const addRuleTool = defineTool({
	name: "command_gate_add_rule",
	label: "Command gate: add rule",
	description: `Add a global bash command-gate rule to ${GLOBAL_RULES_PATH}. Use this instead of editing command-gate files directly.`,
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
		const config = loadRules();
		const existingIds = new Set(config.bash.map((rule) => rule.id));
		const id = params.id?.trim() || makeRuleId(params.pattern, existingIds);
		if (existingIds.has(id)) {
			throw new Error(`Rule already exists: ${id}`);
		}

		const rule: CommandGateRule = {
			id,
			enabled: true,
			action: params.action,
			pattern: params.pattern,
			...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
			createdAt: nowIso(),
		};
		config.bash.push(rule);
		saveRules(config);
		return textResult(`Added global rule ${id}`, { rule, path: GLOBAL_RULES_PATH });
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
						? GLOBAL_STATE_PATH
						: `${PROJECT_STATE_PATH}#${projectDirectory}`;
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
				const state = loadGlobalState();
				if (!addGlobalRuleDisable(state, params.id)) {
					return textResult(`Rule ${params.id} is already disabled for ${scope}`, {
						scope,
						id: params.id,
						path: GLOBAL_STATE_PATH,
					});
				}
				saveGlobalState(state);
				return textResult(`Disabled rule ${params.id} for ${scope}`, {
					scope,
					id: params.id,
					path: GLOBAL_STATE_PATH,
				});
			}

			const state = loadProjectState();
			if (!addProjectRuleDisable(state, projectDirectory, params.id)) {
				return textResult(`Rule ${params.id} is already disabled for ${scope}`, {
					scope,
					id: params.id,
					path: PROJECT_STATE_PATH,
					directory: projectDirectory,
				});
			}
			saveProjectState(state);
			return textResult(`Disabled rule ${params.id} for ${scope}`, {
				scope,
				id: params.id,
				path: PROJECT_STATE_PATH,
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
