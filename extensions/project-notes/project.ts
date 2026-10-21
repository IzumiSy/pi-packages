import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

const INVALID_ORIGIN =
  "Unsupported or invalid origin URL. Use HTTPS, ssh://, or scp-style SSH with an ASCII host and repository path.";

export function normalizeOrigin(origin: string): string {
  const invalid = () => new Error(INVALID_ORIGIN);
  if (!origin || /[\s\\?#\p{Cc}]/u.test(origin)) throw invalid();

  let host: string;
  let path: string;
  let port = "";
  const url = /^(https|ssh):\/\/([^/]+)\/(.+)$/i.exec(origin);
  if (url) {
    const authority = /^(?:[^@]+@)?([A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(url[2]!);
    if (!authority) throw invalid();
    host = authority[1]!;
    path = url[3]!;
    if (authority[2]) {
      const number = Number(authority[2]);
      if (!Number.isInteger(number) || number < 1 || number > 65535) throw invalid();
      const standard = url[1]!.toLowerCase() === "https" ? 443 : 22;
      if (number !== standard) port = `:${number}`;
    }
  } else {
    const scp = /^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(.+)$/.exec(origin);
    if (!scp) throw invalid();
    host = scp[1]!;
    path = scp[2]!;
  }

  if (!host.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) {
    throw invalid();
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  if (
    !path ||
    !path
      .split("/")
      .every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..")
  ) {
    throw invalid();
  }
  return `${host.toLowerCase()}${port}/${path}`;
}

function git(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
    // Resolve cwd even when Pi inherits repository locations from a Git hook.
    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", env, timeout: 5000 },
      (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== "number") {
          reject(new Error("Unable to run Git while resolving the project."));
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export async function resolveProject(cwd: string): Promise<{ key: string }> {
  const directory = await realpath(cwd);
  const common = await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) {
    if (/^fatal: not a git repository \(or any (?:of the )?parent/.test(common.stderr)) {
      return { key: `cwd:${directory}` };
    }
    throw new Error("Unable to resolve the Git project. Check the repository configuration.");
  }

  const origin = await git(directory, ["config", "--null", "--get-all", "remote.origin.url"]);
  if (origin.code === 0) {
    // Git fetch uses the first configured URL; do not apply insteadOf network aliases.
    return { key: normalizeOrigin(origin.stdout.split("\0")[0]!) };
  }
  if (origin.code !== 1) {
    throw new Error("Unable to read the origin configuration.");
  }
  return { key: `git:${await realpath(common.stdout.replace(/\n$/, ""))}` };
}
