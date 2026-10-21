import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface NoteSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  snippet?: string;
}

export interface Note extends NoteSummary {
  body: string;
  revision: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,119}$/;

function validateId(id: string): void {
  if (!ID.test(id)) {
    throw new Error(
      "Invalid note ID: use 1–120 lowercase ASCII letters, digits, hyphens or underscores; start with a letter or digit.",
    );
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function directory(path: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    if (!(await lstat(path)).isDirectory()) {
      throw new Error(`Unsafe notes directory (not a directory or is a symlink): ${path}`);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readRegularFile(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1) {
    throw new Error(
      `Unsafe notes file (must be a regular file with no symlinks or hard links): ${path}`,
    );
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error(`Unsafe or changed notes file: ${path}`);
    }
    const bytes = await file.readFile();
    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { body, revision: hash(bytes), stat };
  } finally {
    await file.close();
  }
}

function titleOf(body: string, fallback: string): string {
  let fence = "";
  let previous = "";
  for (const line of body.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = "";
      previous = "";
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/.exec(line);
    const title = atx?.[1]?.replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (title) return title.slice(0, 200);
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && previous.trim())
      return previous.trim().slice(0, 200);
    previous = line;
  }
  return fallback;
}

export class NotesStore {
  readonly directory: string;
  private readonly root: string;
  private readonly projectKey: string;

  constructor(root: string, projectKey: string) {
    this.root = resolve(root);
    this.projectKey = projectKey;
    this.directory = join(this.root, hash(projectKey));
  }

  private async available(create = false, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const rootAvailable = await directory(this.root, create);
    signal?.throwIfAborted();
    return rootAvailable && (await directory(this.directory, create));
  }

  private async metadata(create = false, signal?: AbortSignal): Promise<void> {
    const path = join(this.directory, "project.json");
    let body: string;
    try {
      ({ body } = await readRegularFile(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create || (await readdir(this.directory)).some((name) => name !== ".lock")) {
        throw new Error(`Missing project.json in notes directory: ${this.directory}`);
      }
      await this.atomicWrite(
        path,
        `${JSON.stringify({ key: this.projectKey }, null, 2)}\n`,
        false,
        signal,
      );
      return;
    }
    const value: unknown = JSON.parse(body);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      (value as { key?: unknown }).key !== this.projectKey
    ) {
      throw new Error(`Project identity mismatch in notes directory: ${this.directory}`);
    }
  }

  private async atomicWrite(
    path: string,
    body: string,
    replace: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        signal?.throwIfAborted();
        await file.writeFile(body, "utf8");
        signal?.throwIfAborted();
        await file.sync();
      } finally {
        await file.close();
      }
      if (replace) {
        const target = await lstat(path);
        if (!target.isFile() || target.nlink !== 1) throw new Error(`Unsafe notes file: ${path}`);
        signal?.throwIfAborted();
        await rename(temporary, path);
      } else {
        // A hard link publishes the complete file without replacing an existing destination.
        signal?.throwIfAborted();
        await link(temporary, path);
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }

  private async locked<T>(
    create: boolean,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!(await this.available(create, signal))) throw new Error("Notes directory does not exist.");
    signal?.throwIfAborted();
    const lock = join(this.directory, ".lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Notes are locked: ${lock}. Retry later. After a crash, remove this empty lock directory manually only after all writers have stopped.`,
        );
      }
      throw error;
    }
    try {
      signal?.throwIfAborted();
      await this.metadata(create, signal);
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await rmdir(lock);
    }
  }

  async read(id: string): Promise<Note> {
    validateId(id);
    if (!(await this.available())) throw new Error(`Note not found: ${id}`);
    await this.metadata();
    let content;
    try {
      content = await readRegularFile(join(this.directory, `${id}.md`));
    } catch (error) {
      if (isMissing(error)) throw new Error(`Note not found: ${id}`);
      throw error;
    }
    return {
      id,
      title: titleOf(content.body, id),
      body: content.body,
      revision: content.revision,
      createdAt: content.stat.birthtime.toISOString(),
      updatedAt: content.stat.mtime.toISOString(),
    };
  }

  async list(query?: string): Promise<NoteSummary[]> {
    if (!(await this.available())) return [];
    await this.metadata();
    const needle = query?.trim().toLowerCase() ?? "";
    const notes: NoteSummary[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".md") || !ID.test(name.slice(0, -3))) continue;
      const { body, revision: _revision, ...summary } = await this.read(name.slice(0, -3));
      if (needle && !`${summary.id}\n${summary.title}\n${body}`.toLowerCase().includes(needle))
        continue;
      if (needle) {
        const index = body.toLowerCase().indexOf(needle);
        let originalIndex = 0;
        let lowercaseIndex = 0;
        // Lowercasing can expand characters; slice the excerpt using original-body offsets.
        if (index >= 0) {
          for (const character of body) {
            const length = character.toLowerCase().length;
            if (lowercaseIndex + length > index) break;
            lowercaseIndex += length;
            originalIndex += character.length;
          }
        }
        const start = Math.max(0, originalIndex - 60);
        summary.snippet = body.slice(start, start + 200);
      }
      notes.push(summary);
    }
    return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async create(id: string, body: string, signal?: AbortSignal): Promise<Note> {
    validateId(id);
    return this.locked(
      true,
      async () => {
        const path = join(this.directory, `${id}.md`);
        try {
          await lstat(path);
          throw new Error(`Note already exists: ${id}`);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await this.atomicWrite(path, body, false, signal);
        return this.read(id);
      },
      signal,
    );
  }

  async delete(id: string, expectedRevision: string, signal?: AbortSignal): Promise<void> {
    validateId(id);
    if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error("Invalid expected revision.");
    return this.locked(
      false,
      async () => {
        const current = await this.read(id);
        signal?.throwIfAborted();
        if (current.revision !== expectedRevision) {
          throw new Error(
            `Revision conflict for note ${id}. Confirm the latest note before deleting; nothing was deleted.`,
          );
        }
        await unlink(join(this.directory, `${id}.md`));
      },
      signal,
    );
  }

  async update(
    id: string,
    body: string,
    expectedRevision: string,
    signal?: AbortSignal,
  ): Promise<Note> {
    validateId(id);
    if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error("Invalid expected revision.");
    return this.locked(
      false,
      async () => {
        const current = await this.read(id);
        signal?.throwIfAborted();
        if (current.revision !== expectedRevision) {
          throw new Error(
            `Revision conflict for note ${id}. Read the latest complete note before updating; nothing was saved.`,
          );
        }
        await this.atomicWrite(join(this.directory, `${id}.md`), body, true, signal);
        return this.read(id);
      },
      signal,
    );
  }
}
