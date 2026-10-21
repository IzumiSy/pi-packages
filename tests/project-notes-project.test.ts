import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOrigin, resolveProject } from "../extensions/project-notes/project.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "project-notes-identity-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });
}

async function repository(name: string, origin?: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path);
  git(path, "init", "--quiet");
  if (origin !== undefined) git(path, "config", "remote.origin.url", origin);
  return path;
}

describe("project-notes origin normalization", () => {
  it.each([
    "git@GitHub.com:Owner/App.git",
    "https://GITHUB.com/Owner/App.git/",
    "https://user:secret@github.com:443/Owner/App",
    "ssh://git@github.com:22/Owner/App.git",
    "github.com:Owner/App/",
  ])("normalizes %s without credentials", (origin) => {
    expect(normalizeOrigin(origin)).toBe("github.com/Owner/App");
  });

  it("preserves nested namespace and repository case, owner, port, and SSH alias differences", () => {
    expect(normalizeOrigin("git@gitlab.example.com:Group/Sub/App.git")).toBe(
      "gitlab.example.com/Group/Sub/App",
    );
    expect(normalizeOrigin("https://github.com/owner/app.git")).not.toBe(
      normalizeOrigin("https://github.com/fork/app.git"),
    );
    expect(normalizeOrigin("https://github.com/Owner/App.git")).not.toBe(
      normalizeOrigin("https://github.com/owner/app.git"),
    );
    expect(normalizeOrigin("ssh://git@github.com:2222/owner/app.git")).toBe(
      "github.com:2222/owner/app",
    );
    expect(normalizeOrigin("https://github.com:8443/owner/app.git")).toBe(
      "github.com:8443/owner/app",
    );
    expect(normalizeOrigin("git@github-work:owner/app.git")).toBe("github-work/owner/app");
  });

  it.each([
    "",
    "/local/repo.git",
    "../repo.git",
    "file:///local/repo.git",
    "git://github.com/owner/app.git",
    "http://github.com/owner/app.git",
    "https://github.com/owner/../app.git",
    "https://github.com/owner/%2e%2e/app.git",
    "https://github.com/owner%2fother/app.git",
    "https://github.com//owner/app.git",
    "https://github.com/owner/app.git?token=secret",
    "https://github.com/owner/app.git#fragment",
    "https://github.com:0/owner/app.git",
    "ssh://git@github.com:65536/owner/app.git",
    "https://github.com:/owner/app.git",
    "https://github.com./owner/app.git",
    "https://github..com/owner/app.git",
    "https://github.com/owner\\app.git",
    "git@github.com:/absolute/app.git",
    "git@github.com:owner/./app.git",
    "git@github.com:owner/app.git\n",
    "https://[::1]/owner/app.git",
    "https://github.com/owner/.git",
    "https://github.com/owner/日本語.git",
    "https://user:secret@invalid_host/owner/app.git",
    "https://user:secret@github.com/owner/../app.git",
  ])("rejects unsupported or ambiguous origin %s without leaking it", (origin) => {
    expect(() => normalizeOrigin(origin)).toThrow("Unsupported or invalid origin URL");
    try {
      normalizeOrigin(origin);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

describe("project-notes project resolution", () => {
  it("shares identity across separate clones and subdirectories using only local config", async () => {
    const first = await repository("clone-one", "git@github.com:owner/app.git");
    const second = await repository("clone-two", "https://user:secret@github.com/owner/app.git");
    const nested = join(first, "src");
    await mkdir(nested);
    git(second, "config", "url.ssh://unrelated.invalid/.insteadOf", "https://github.com/");

    expect(await resolveProject(first)).toEqual({ key: "github.com/owner/app" });
    expect(await resolveProject(nested)).toEqual(await resolveProject(second));
    expect(JSON.stringify(await resolveProject(second))).not.toContain("secret");
    expect(await readFile(join(second, ".git", "config"), "utf8")).toContain("secret");
  });

  it("resolves cwd instead of repository locations inherited from a Git hook", async () => {
    const requested = await repository("requested", "git@github.com:owner/requested.git");
    const inherited = await repository("inherited", "git@github.com:owner/inherited.git");
    vi.stubEnv("GIT_DIR", join(inherited, ".git"));
    vi.stubEnv("GIT_COMMON_DIR", join(inherited, ".git"));
    vi.stubEnv("GIT_WORK_TREE", inherited);
    expect(await resolveProject(requested)).toEqual({ key: "github.com/owner/requested" });
  });

  it("uses the first URL, matching Git's fetch behavior", async () => {
    const repo = await repository("multiple", "https://github.com/owner/first.git");
    git(repo, "config", "--add", "remote.origin.url", "https://github.com/owner/second.git");
    expect(await resolveProject(repo)).toEqual({ key: "github.com/owner/first" });
  });

  it("uses the real common Git directory for origin-less repositories and worktrees", async () => {
    const repo = await repository("origin-less");
    git(
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Initial",
    );
    const worktree = join(root, "linked-worktree");
    git(repo, "worktree", "add", "--quiet", "--detach", worktree);
    const expected = { key: `git:${await realpath(join(repo, ".git"))}` };
    expect(await resolveProject(repo)).toEqual(expected);
    expect(await resolveProject(worktree)).toEqual(expected);
  });

  it("uses each real cwd outside Git, including symlinked cwd", async () => {
    const first = join(root, "outside-one");
    const second = join(root, "outside-two");
    const alias = join(root, "alias");
    await mkdir(first);
    await mkdir(second);
    await symlink(first, alias);
    expect(await resolveProject(first)).toEqual({ key: `cwd:${await realpath(first)}` });
    expect(await resolveProject(alias)).toEqual(await resolveProject(first));
    expect(await resolveProject(second)).not.toEqual(await resolveProject(first));
  });

  it.each(["", "file:///local/repo.git", "https://user:secret@github.com/owner/../app.git"])(
    "does not fall back when origin exists but is invalid: %s",
    async (origin) => {
      const repo = await repository("invalid-origin", origin);
      await expect(resolveProject(repo)).rejects.toThrow("Unsupported or invalid origin URL");
      await expect(resolveProject(repo)).rejects.not.toThrow("secret");
    },
  );

  it("does not treat a broken Git configuration as a non-Git cwd", async () => {
    const repo = await repository("broken");
    await writeFile(join(repo, ".git", "config"), "[invalid configuration\n");
    await expect(resolveProject(repo)).rejects.toThrow("Unable to resolve the Git project");
  });
});
