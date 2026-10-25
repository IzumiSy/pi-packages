const { execFileSync } = require("node:child_process");

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
}

try {
  const repoDir = process.argv[2];
  if (!repoDir) {
    throw new Error("usage: node fetch-unresolved-review-threads.js <repo-path>");
  }
  const repoRoot = run("git", ["-C", repoDir, "rev-parse", "--show-toplevel"]);
  const branch = run("git", ["branch", "--show-current"], repoRoot);
  if (!branch) throw new Error("could not determine current branch (detached HEAD)");

  const pr = JSON.parse(run("gh", ["pr", "view", "--json", "number,title,url"], repoRoot));
  const url = new URL(pr.url);
  const [, owner, repo] = url.pathname.split("/");
  if (!owner || !repo || !Number.isSafeInteger(pr.number) || typeof pr.title !== "string") {
    throw new Error("invalid gh pr view response");
  }

  const query = `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved isOutdated path
            firstComment: comments(first: 1) {
              nodes { author { login } body line originalLine diffHunk }
            }
            latestComments: comments(last: 2) {
              nodes { author { login } body line originalLine }
            }
          }
        }
      }
    }
  }`;
  const pages = JSON.parse(
    run(
      "gh",
      [
        "api",
        "graphql",
        "--hostname",
        url.hostname,
        "--paginate",
        "--slurp",
        "-f",
        `owner=${owner}`,
        "-f",
        `repo=${repo}`,
        "-F",
        `pr=${pr.number}`,
        "-f",
        `query=${query}`,
      ],
      repoRoot,
    ),
  );
  const unresolvedThreads = pages
    .flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes)
    .filter((thread) => thread.isResolved === false);

  process.stdout.write(JSON.stringify({ branch, pr, unresolvedThreads }) + "\n");
} catch (error) {
  process.stderr.write(`error: ${error.stderr?.toString().trim() || error.message}\n`);
  process.exitCode = 1;
}
