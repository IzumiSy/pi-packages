import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("skills/pr-review-plan/scripts/fetch-unresolved-review-threads.js");
const pr = { number: 42, title: "Example PR", url: "https://github.com/owner/123/pull/42" };
const unresolved = {
  isResolved: false,
  isOutdated: false,
  path: "src/example.ts",
  firstComment: { nodes: [{ body: "Check this branch", line: 10, diffHunk: "@@ example" }] },
  latestComments: { nodes: [{ body: "Still relevant", line: 10 }] },
};
const outdated = { ...unresolved, isOutdated: true, path: "src/old.ts" };
const resolved = { ...unresolved, isResolved: true, path: "RESOLVED_PRIVATE_DATA" };
let sandbox: string;
let repo: string;
let log: string;
let env: NodeJS.ProcessEnv;

function page(nodes: unknown[]) {
  return { data: { repository: { pullRequest: { reviewThreads: { nodes } } } } };
}

function run(args = [repo]) {
  return spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pr-review-plan-"));
  repo = join(sandbox, "repo with spaces");
  const bin = join(sandbox, "bin");
  log = join(sandbox, "requests.jsonl");
  await mkdir(repo);
  await mkdir(bin);
  execFileSync("git", ["init", "--quiet", "--initial-branch=feature/review", repo]);
  await writeFile(
    join(bin, "gh"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_REQUEST_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === process.env.TEST_ERROR_COMMAND) {
  process.stderr.write("fixture: no PR or authentication unavailable\\n");
  process.exit(1);
}
if (args[0] === "pr") process.stdout.write(process.env.TEST_PR);
else if (args[0] === "api") process.stdout.write(process.env.TEST_PAGES);
else process.exit(1);
`,
    { mode: 0o755 },
  );
  env = {
    ...process.env,
    PATH: bin + delimiter + process.env.PATH,
    TEST_REQUEST_LOG: log,
    TEST_PR: JSON.stringify(pr),
    TEST_PAGES: JSON.stringify([page([unresolved, resolved]), page([outdated])]),
  };
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("pr-review-plan helper", () => {
  it("outputs only unresolved threads across pages, retaining outdated threads and comment data", async () => {
    const nested = join(repo, "subdir");
    await mkdir(nested);
    const result = run([nested]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("RESOLVED_PRIVATE_DATA");
    expect(JSON.parse(result.stdout)).toEqual({
      branch: "feature/review",
      pr,
      unresolvedThreads: [unresolved, outdated],
    });

    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(2);
    expect(requests[0].args).toEqual(["pr", "view", "--json", "number,title,url"]);
    expect(requests.every((request) => request.cwd === requests[0].cwd)).toBe(true);
    expect(requests[0].cwd).toBe(
      execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim(),
    );
    const args: string[] = requests[1].args;
    expect(args).toEqual(
      expect.arrayContaining(["api", "graphql", "--paginate", "--slurp", "github.com"]),
    );
    expect(args).not.toContain("--jq");
    expect(args[args.indexOf("owner=owner") - 1]).toBe("-f");
    expect(args[args.indexOf("repo=123") - 1]).toBe("-f");
    expect(args[args.indexOf("pr=42") - 1]).toBe("-F");
    const query = args.find((arg) => arg.startsWith("query="))!;
    expect(query).toContain("$endCursor: String");
    expect(query).toContain("after: $endCursor");
    expect(query).toContain("pageInfo { hasNextPage endCursor }");
    expect(query).toContain("firstComment: comments(first: 1)");
    expect(query).toContain("latestComments: comments(last: 2)");
  });

  it("returns an empty array when all threads are resolved", () => {
    env.TEST_PAGES = JSON.stringify([page([resolved]), page([])]);
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).unresolvedThreads).toEqual([]);
  });

  it("requires an explicit repository path", () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
    expect(result.stdout).toBe("");
  });

  it("rejects a non-repository path", () => {
    const result = run([sandbox]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a git repository");
    expect(result.stdout).toBe("");
  });

  it.each(["pr", "api"])("reports gh %s failures without printing partial JSON", (command) => {
    env.TEST_ERROR_COMMAND = command;
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no PR or authentication unavailable");
    expect(result.stdout).toBe("");
  });

  it.each(["not json", "{}", '[{"data":{"repository":null}}]'])(
    "rejects invalid thread output: %s",
    (output) => {
      env.TEST_PAGES = output;
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("error:");
      expect(result.stdout).toBe("");
    },
  );
});
