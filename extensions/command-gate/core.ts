import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type RuleAction = "block" | "confirm";
export type DisableScope = "session" | "project" | "global";

export interface CommandGateRule {
	id: string;
	enabled: boolean;
	action: RuleAction;
	pattern: string;
	reason?: string;
	createdAt?: string;
	disabledAt?: string;
}

export interface CommandGateConfig {
	bash: CommandGateRule[];
}

export interface GlobalState {
	disabledRuleIds: string[];
}

export interface ProjectState {
	disabledRuleIdsByDirectory: Record<string, string[]>;
}

export interface EffectiveRule {
	rule: CommandGateRule;
	disabledInConfig: boolean;
	disabledBy: DisableScope[];
	effectiveEnabled: boolean;
}

export interface CommandGatePaths {
	projectRoot: string;
	globalRulesPath: string;
	globalStatePath: string;
	projectStatePath: string;
}

export interface EffectiveRulesInput {
	config: CommandGateConfig;
	globalState: GlobalState;
	projectState: ProjectState;
	sessionState: GlobalState;
	cwd: string;
	projectRoot: string;
}

export function createCommandGatePaths(projectRoot: string, homeDir: string): CommandGatePaths {
	const globalConfigDir = resolve(homeDir, ".pi", "agent", "command-gate");
	return {
		projectRoot,
		globalRulesPath: resolve(globalConfigDir, "global.json"),
		globalStatePath: resolve(globalConfigDir, "global-state.json"),
		projectStatePath: resolve(globalConfigDir, "project-state.json"),
	};
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function cloneRule(rule: CommandGateRule): CommandGateRule {
	return { ...rule };
}

export function loadJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function normalizeIdList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
}

export function normalizeDirectoryRuleMap(value: unknown): Record<string, string[]> {
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

export function defaultGlobalState(): GlobalState {
	return { disabledRuleIds: [] };
}

export function defaultProjectState(): ProjectState {
	return { disabledRuleIdsByDirectory: {} };
}

export function normalizeGlobalState(value: unknown): GlobalState {
	if (!value || typeof value !== "object") return defaultGlobalState();
	const candidate = value as Partial<GlobalState>;
	return { disabledRuleIds: normalizeIdList(candidate.disabledRuleIds) };
}

export function normalizeProjectState(value: unknown): ProjectState {
	if (!value || typeof value !== "object") return defaultProjectState();
	const candidate = value as Partial<ProjectState>;
	return {
		disabledRuleIdsByDirectory: normalizeDirectoryRuleMap(candidate.disabledRuleIdsByDirectory),
	};
}

export function normalizeRule(value: unknown): CommandGateRule | undefined {
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

export function parseSeedRules(seedConfig: unknown, sourceLabel = "command-gate seed config"): CommandGateRule[] {
	if (!seedConfig || typeof seedConfig !== "object") {
		throw new Error(`Invalid command-gate seed config: ${sourceLabel}`);
	}

	const candidate = seedConfig as Partial<CommandGateConfig>;
	const rules = Array.isArray(candidate.bash)
		? candidate.bash.map(normalizeRule).filter((rule): rule is CommandGateRule => rule !== undefined)
		: [];
	if (rules.length === 0) {
		throw new Error(`Command-gate seed config has no valid rules: ${sourceLabel}`);
	}
	return rules;
}

export function defaultConfig(seedRules: CommandGateRule[]): CommandGateConfig {
	return { bash: seedRules.map(cloneRule) };
}

export function normalizeConfig(value: unknown, seedRules: CommandGateRule[]): CommandGateConfig {
	if (!value || typeof value !== "object") return defaultConfig(seedRules);
	const candidate = value as Partial<CommandGateConfig>;
	const rules = Array.isArray(candidate.bash)
		? candidate.bash.map(normalizeRule).filter((rule): rule is CommandGateRule => rule !== undefined)
		: [];
	return {
		bash: rules.length === 0 ? seedRules.map(cloneRule) : rules,
	};
}

export function loadRulesFromPath(path: string, seedRules: CommandGateRule[]): CommandGateConfig {
	return normalizeConfig(loadJson(path), seedRules);
}

export function saveRules(path: string, config: CommandGateConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function ensureRulesFile(paths: CommandGatePaths, seedRules: CommandGateRule[]): CommandGateConfig {
	if (existsSync(paths.globalRulesPath)) {
		return loadRulesFromPath(paths.globalRulesPath, seedRules);
	}

	const config = defaultConfig(seedRules);
	saveRules(paths.globalRulesPath, config);
	return config;
}

export function loadRules(paths: CommandGatePaths, seedRules: CommandGateRule[]): CommandGateConfig {
	return ensureRulesFile(paths, seedRules);
}

export function saveGlobalState(path: string, state: GlobalState): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function saveProjectState(path: string, state: ProjectState): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function addDisabledRuleIds(target: string[], ids: string[]): boolean {
	let changed = false;
	for (const id of ids) {
		if (target.includes(id)) continue;
		target.push(id);
		changed = true;
	}
	return changed;
}

export function addDirectoryDisabledRuleIds(target: Record<string, string[]>, directory: string, ids: string[]): boolean {
	if (typeof directory !== "string" || directory.trim() === "" || ids.length === 0) return false;
	const current = target[directory] ?? [];
	const next = [...current];
	const changed = addDisabledRuleIds(next, ids);
	if (!changed) return false;
	target[directory] = next;
	return true;
}

export function isWithinDirectory(root: string, target: string): boolean {
	const relPath = relative(root, target);
	return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

export function loadGlobalState(path: string): GlobalState {
	if (!existsSync(path)) return defaultGlobalState();
	return normalizeGlobalState(loadJson(path));
}

export function loadProjectState(path: string): ProjectState {
	if (!existsSync(path)) return defaultProjectState();
	return normalizeProjectState(loadJson(path));
}

export function getProjectDirectoryKeys(projectRoot: string, cwd: string): string[] {
	const resolvedCwd = resolve(cwd);
	if (!isWithinDirectory(projectRoot, resolvedCwd)) return [];
	const relPath = relative(projectRoot, resolvedCwd);
	if (relPath === "") return [projectRoot];
	const segments = relPath.split(/[\\/]+/).filter(Boolean);
	return [projectRoot, ...segments.map((_segment, index) => resolve(projectRoot, ...segments.slice(0, index + 1)))];
}

export function makeRuleId(pattern: string, existingIds: Set<string>): string {
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

export function formatScopeList(scopes: DisableScope[]): string {
	return scopes.join(", ");
}

export function formatRule(ruleInfo: EffectiveRule): string {
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

export function formatRulesReport(input: { rules: EffectiveRule[]; paths: CommandGatePaths; cwd: string }): string {
	const { rules, paths, cwd } = input;
	const lines = [
		`Rules file: ${paths.globalRulesPath}`,
		`Global overrides: ${paths.globalStatePath}`,
		`Project overrides: ${paths.projectStatePath}`,
		`Project root: ${paths.projectRoot}`,
		`Current directory: ${cwd}`,
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

export function hasGlobalRuleDisabled(id: string, state: GlobalState): boolean {
	return state.disabledRuleIds.includes(id);
}

export function hasProjectRuleDisabled(id: string, state: ProjectState, directoryKeys: string[]): boolean {
	return directoryKeys.some((directory) => state.disabledRuleIdsByDirectory[directory]?.includes(id) === true);
}

export function addGlobalRuleDisable(state: GlobalState, id: string): boolean {
	if (state.disabledRuleIds.includes(id)) return false;
	state.disabledRuleIds.push(id);
	return true;
}

export function addProjectRuleDisable(state: ProjectState, directory: string, id: string): boolean {
	return addDirectoryDisabledRuleIds(state.disabledRuleIdsByDirectory, directory, [id]);
}

export function getEffectiveRulesFromState(input: EffectiveRulesInput): EffectiveRule[] {
	const { config, globalState, projectState, sessionState, cwd, projectRoot } = input;
	const projectDirectoryKeys = getProjectDirectoryKeys(projectRoot, cwd);

	return config.bash.map((rule) => {
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

export function findMatchingRule(command: string, rules: EffectiveRule[]): CommandGateRule | undefined {
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
