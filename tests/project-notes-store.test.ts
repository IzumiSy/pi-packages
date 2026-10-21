import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesStore } from "../extensions/project-notes/store.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

let temporary: string;
let root: string;
let store: NotesStore;
const key = "github.com/owner/app";

beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation(
    (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open,
  );
  temporary = await mkdtemp(join(tmpdir(), "project-notes-store-"));
  root = join(temporary, "notes");
  store = new NotesStore(root, key);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { recursive: true, force: true });
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writer(operation: "create" | "update" | "delete", revision: string, body: string) {
  const source = pathToFileURL(join(process.cwd(), "extensions/project-notes/store.ts")).href;
  const script = `
    import { NotesStore } from ${JSON.stringify(source)};
    const store = new NotesStore(${JSON.stringify(root)}, ${JSON.stringify(key)});
    process.once("message", async () => {
      try {
        const note = await store.${operation}("shared", ${JSON.stringify(operation === "delete" ? revision : body)}${operation === "update" ? `, ${JSON.stringify(revision)}` : ""});
        process.send({ ok: true, body: note?.body });
      } catch (error) {
        process.send({ ok: false, error: error.message });
      } finally {
        process.disconnect();
      }
    });
    process.send({ ready: true });
  `;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  let outcome: { ok: boolean; body?: string; error?: string } | undefined;
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message) => {
      if ((message as { ready?: boolean }).ready) resolve();
      else outcome = message as typeof outcome;
    });
    child.on("error", reject);
    child.on("exit", () => reject(new Error(`Writer exited before ready: ${stderr}`)));
  });
  const result = new Promise<NonNullable<typeof outcome>>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && outcome) resolve(outcome);
      else reject(new Error(`Writer failed (${code}): ${stderr}`));
    });
  });
  return { child, ready, result };
}

describe("project-notes storage", () => {
  it("does not create storage during read-only access", async () => {
    expect(await store.list()).toEqual([]);
    await expect(store.read("missing")).rejects.toThrow("Note not found");
    await expect(store.update("missing", "body", digest("body"))).rejects.toThrow("does not exist");
    await expect(store.delete("missing", digest("body"))).rejects.toThrow("does not exist");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates private plain Markdown and minimal identity metadata in a hashed directory", async () => {
    const note = await store.create("api-design", "# API design\n\nA draft.\n");
    expect(store.directory).toBe(join(root, digest(key)));
    expect(note).toMatchObject({
      id: "api-design",
      title: "API design",
      body: "# API design\n\nA draft.\n",
      revision: digest("# API design\n\nA draft.\n"),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(await readFile(join(store.directory, "api-design.md"), "utf8")).toBe(note.body);
    expect(JSON.parse(await readFile(join(store.directory, "project.json"), "utf8"))).toEqual({
      key,
    });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.directory, "api-design.md"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(store.directory, "project.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(store.directory)).toEqual(["api-design.md", "project.json"]);
    expect(await new NotesStore(root, key).read("api-design")).toEqual(note);
    expect(await new NotesStore(root, "github.com/fork/app").list()).toEqual([]);
  });

  it("never overwrites an existing note on create", async () => {
    const original = await store.create("api-design", "# Original\nKeep me.");
    await expect(store.create("api-design", "# Replacement")).rejects.toThrow("already exists");
    expect(await store.read("api-design")).toEqual(original);
    expect(await readdir(store.directory)).toEqual(["api-design.md", "project.json"]);
  });

  it("updates only the expected revision and keeps IDs stable when titles change", async () => {
    const original = await store.create("api-design", "# Original");
    const updated = await store.update("api-design", "# Renamed\nNew text.", original.revision);
    expect(updated).toMatchObject({
      id: "api-design",
      title: "Renamed",
      body: "# Renamed\nNew text.",
    });
    expect(updated.revision).not.toBe(original.revision);
    await expect(store.update("api-design", "Lost update", original.revision)).rejects.toThrow(
      "Revision conflict",
    );
    expect(await store.read("api-design")).toEqual(updated);
    expect(await readdir(store.directory)).toEqual(["api-design.md", "project.json"]);
  });

  it("requires a content hash as expected revision", async () => {
    const note = await store.create("api", "# API");
    await expect(store.update("api", "Changed", "")).rejects.toThrow("Invalid expected revision");
    await expect(store.update("api", "Changed", "not-a-hash")).rejects.toThrow(
      "Invalid expected revision",
    );
    await expect(store.delete("api", "")).rejects.toThrow("Invalid expected revision");
    await expect(store.delete("api", "not-a-hash")).rejects.toThrow("Invalid expected revision");
    expect(await store.read("api")).toEqual(note);
  });

  it("deletes only the expected note and keeps project metadata even after the last note is deleted", async () => {
    const removed = await store.create("remove", "# Remove me");
    const kept = await store.create("keep", "# Keep me");
    const metadata = await readFile(join(store.directory, "project.json"), "utf8");
    await store.delete(removed.id, removed.revision);
    await expect(store.read(removed.id)).rejects.toThrow("Note not found");
    expect(await store.read(kept.id)).toEqual(kept);
    expect(await readFile(join(store.directory, "project.json"), "utf8")).toBe(metadata);
    expect(await readdir(store.directory)).toEqual(["keep.md", "project.json"]);
    await store.delete(kept.id, kept.revision);
    expect(await readdir(store.directory)).toEqual(["project.json"]);
    expect(await store.list()).toEqual([]);
  });

  it("does not delete a changed or already missing note and releases its lock after failure", async () => {
    const original = await store.create("note", "Original");
    const updated = await store.update("note", "Changed after confirmation", original.revision);
    await expect(store.delete("note", original.revision)).rejects.toThrow("Revision conflict");
    expect(await store.read("note")).toEqual(updated);
    await expect(store.delete("missing", original.revision)).rejects.toThrow("Note not found");
    expect(await readdir(store.directory)).toEqual(["note.md", "project.json"]);
  });

  it("does not delete a note when cancellation is already requested", async () => {
    const original = await store.create("note", "Original");
    const controller = new AbortController();
    controller.abort();
    await expect(store.delete("note", original.revision, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await store.read("note")).toEqual(original);
    expect(await readdir(store.directory)).toEqual(["note.md", "project.json"]);
  });

  it("does not delete a note cancelled after the asynchronous current-content read", async () => {
    const original = await store.create("note", "Original");
    const controller = new AbortController();
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementationOnce(async (id) => {
      const current = await read(id);
      controller.abort();
      return current;
    });
    await expect(store.delete("note", original.revision, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await store.read("note")).toEqual(original);
    expect(await readdir(store.directory)).toEqual(["note.md", "project.json"]);
  });

  it("lists summaries and searches ID, title, or body case-insensitively with short excerpts", async () => {
    await store.create(
      "api-design",
      "# API design\n\n" + "before ".repeat(60) + "Needle in body." + " after".repeat(60),
    );
    await store.create("other", "No heading here.");
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.find((entry) => entry.id === "other")).toMatchObject({ title: "other" });
    expect(
      list.every((entry) => !("body" in entry) && !("revision" in entry) && !("snippet" in entry)),
    ).toBe(true);
    for (const query of ["API-DESIGN", "API DESIGN", "  NEEDLE  "]) {
      const found = await store.list(query);
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe("api-design");
      expect(found[0]?.snippet?.length).toBeLessThanOrEqual(200);
    }
    expect((await store.list("needle"))[0]?.snippet).toContain("Needle in body");
    expect(await store.list("absent")).toEqual([]);
  });

  it("finds excerpts at original offsets after Unicode lowercase expansion and keeps queries literal", async () => {
    await store.create("unicode", "# Test\n" + "İ".repeat(400) + "\nNeedle a+b[0].* is here.");
    for (const query of ["needle", "a+b[0].*"]) {
      const matches = await store.list(query);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.snippet).toContain("Needle a+b[0].* is here.");
    }
    expect((await store.list("i\u0307"))[0]?.snippet).toContain("İ");
    expect(await store.list("a+b[1].*")).toEqual([]);
  });

  it("rejects a pre-aborted create before creating storage", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(store.create("note", "Never saved", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish an update cancelled after the asynchronous current-content read", async () => {
    const original = await store.create("note", "Original");
    const controller = new AbortController();
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementationOnce(async (id) => {
      const current = await read(id);
      controller.abort();
      return current;
    });
    await expect(
      store.update("note", "Not published", original.revision, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.read("note")).toEqual(original);
    expect(await readdir(store.directory)).toEqual(["note.md", "project.json"]);
  });

  it.each(["metadata", "create", "update"] as const)(
    "cleans its temporary file and lock when %s publication is cancelled",
    async (stage) => {
      const original = stage === "metadata" ? undefined : await store.create("note", "Original");
      const controller = new AbortController();
      const originalOpen = (
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      ).open;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const file = await originalOpen(...args);
        if (String(args[0]).includes(".tmp-")) {
          const sync = file.sync.bind(file);
          vi.spyOn(file, "sync").mockImplementation(async () => {
            await sync();
            controller.abort();
          });
        }
        return file;
      });
      const operation =
        stage === "update"
          ? store.update("note", "Not published", original!.revision, controller.signal)
          : store.create("new", "Not published", controller.signal);
      await expect(operation).rejects.toMatchObject({ name: "AbortError" });
      expect(await readdir(store.directory)).toEqual(
        stage === "metadata" ? [] : ["note.md", "project.json"],
      );
      if (original) expect(await store.read("note")).toEqual(original);
    },
  );

  it("keeps its lock until an aborted in-flight sync has settled", async () => {
    await store.create("note", "Original");
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const syncing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalOpen = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).open;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await originalOpen(...args);
      if (String(args[0]).includes(".tmp-")) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, "sync").mockImplementation(async () => {
          entered();
          await pending;
          await sync();
        });
      }
      return file;
    });
    const operation = store.create("new", "Not published", controller.signal);
    await syncing;
    controller.abort();
    expect((await lstat(join(store.directory, ".lock"))).isDirectory()).toBe(true);
    release();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(store.directory)).toEqual(["note.md", "project.json"]);
  });

  it("uses the first heading outside fenced code, including setext headings", async () => {
    expect(
      (await store.create("fenced", "```md\n# Not a heading\n```\n## Real title ##\n# Later"))
        .title,
    ).toBe("Real title");
    expect((await store.create("setext", "Setext heading\n==============\n\nText")).title).toBe(
      "Setext heading",
    );
    expect((await store.create("long-title", "# " + "a".repeat(500))).title).toHaveLength(200);
  });

  it("preserves UTF-8 and BOM bytes in revisions and rejects invalid UTF-8 rather than losing bytes", async () => {
    const body = "\ufeff# 日本語\n本文😀\n";
    const created = await store.create("unicode", body);
    expect(created.body).toBe(body);
    expect(created.title).toBe("日本語");
    expect(created.revision).toBe(digest(body));
    await writeFile(join(store.directory, "unicode.md"), Buffer.from([0xff]));
    await expect(store.read("unicode")).rejects.toThrow();
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "/tmp/escape",
    "foo/bar",
    "foo\\bar",
    "%2e%2e",
    "note.md",
    "Note",
    "a".repeat(121),
  ])("rejects invalid ID %s without touching storage", async (id) => {
    await expect(store.create(id, "body")).rejects.toThrow("Invalid note ID");
    await expect(store.read(id)).rejects.toThrow("Invalid note ID");
    await expect(store.update(id, "body", digest("body"))).rejects.toThrow("Invalid note ID");
    await expect(store.delete(id, digest("body"))).rejects.toThrow("Invalid note ID");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses root and project directory symlinks without modifying their targets", async () => {
    const outside = join(temporary, "outside");
    await mkdir(outside);
    await symlink(outside, root);
    await expect(store.list()).rejects.toThrow("Unsafe notes directory");
    await expect(store.create("escaped", "body")).rejects.toThrow("Unsafe notes directory");
    await expect(store.delete("escaped", digest("body"))).rejects.toThrow("Unsafe notes directory");
    expect(await readdir(outside)).toEqual([]);
    await unlink(root);
    await mkdir(root);
    await symlink(outside, store.directory);
    await expect(store.read("escaped")).rejects.toThrow("Unsafe notes directory");
    await expect(store.create("escaped", "body")).rejects.toThrow("Unsafe notes directory");
    await expect(store.delete("escaped", digest("body"))).rejects.toThrow("Unsafe notes directory");
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(["root", "project", "metadata"])(
    "refuses dangling %s symlinks without creating their targets",
    async (target) => {
      const outside = join(temporary, "missing-target");
      if (target === "root") await symlink(outside, root);
      else if (target === "project") {
        await mkdir(root);
        await symlink(outside, store.directory);
      } else {
        await store.create("existing", "Original");
        await unlink(join(store.directory, "project.json"));
        await symlink(outside, join(store.directory, "project.json"));
      }
      await expect(store.list()).rejects.toThrow();
      await expect(store.create("new", "Changed")).rejects.toThrow();
      await expect(store.delete("existing", digest("Original"))).rejects.toThrow();
      await expect(lstat(outside)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([false, true])(
    "refuses note symlinks, including dangling symlinks (dangling=%s)",
    async (dangling) => {
      await store.create("existing", "# Existing");
      const outside = join(temporary, "outside.md");
      if (!dangling) await writeFile(outside, "Do not read or modify me.");
      await symlink(outside, join(store.directory, "escaped.md"));
      await expect(store.read("escaped")).rejects.toThrow("Unsafe notes file");
      await expect(store.list()).rejects.toThrow("Unsafe notes file");
      await expect(store.create("escaped", "Changed")).rejects.toThrow("already exists");
      await expect(
        store.update("escaped", "Changed", digest("Do not read or modify me.")),
      ).rejects.toThrow("Unsafe notes file");
      await expect(store.delete("escaped", digest("Do not read or modify me."))).rejects.toThrow(
        "Unsafe notes file",
      );
      expect((await lstat(join(store.directory, "escaped.md"))).isSymbolicLink()).toBe(true);
      if (!dangling) expect(await readFile(outside, "utf8")).toBe("Do not read or modify me.");
      else await expect(lstat(outside)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects metadata symlinks and hard links", async () => {
    await store.create("note", "body");
    const metadata = join(store.directory, "project.json");
    const outside = join(temporary, "outside.json");
    const original = await readFile(metadata, "utf8");
    await writeFile(outside, original);
    await unlink(metadata);
    await symlink(outside, metadata);
    await expect(store.list()).rejects.toThrow("Unsafe notes file");
    await expect(store.create("new", "body")).rejects.toThrow("Unsafe notes file");
    await expect(store.delete("note", digest("body"))).rejects.toThrow("Unsafe notes file");
    expect(await readFile(outside, "utf8")).toBe(original);
    await unlink(metadata);
    await link(outside, metadata);
    await expect(store.read("note")).rejects.toThrow("Unsafe notes file");
    await expect(store.delete("note", digest("body"))).rejects.toThrow("Unsafe notes file");
  });

  it("rejects hard-linked note files and non-regular note files", async () => {
    await store.create("note", "body");
    const outside = join(temporary, "outside.md");
    await writeFile(outside, "Outside content");
    await link(outside, join(store.directory, "linked.md"));
    await expect(store.read("linked")).rejects.toThrow("Unsafe notes file");
    await expect(store.update("linked", "Changed", digest("Outside content"))).rejects.toThrow(
      "Unsafe notes file",
    );
    await expect(store.delete("linked", digest("Outside content"))).rejects.toThrow(
      "Unsafe notes file",
    );
    expect(await readFile(outside, "utf8")).toBe("Outside content");
    await mkdir(join(store.directory, "directory.md"));
    await expect(store.read("directory")).rejects.toThrow("Unsafe notes file");
    await expect(store.delete("directory", digest("body"))).rejects.toThrow("Unsafe notes file");
    expect((await lstat(join(store.directory, "directory.md"))).isDirectory()).toBe(true);
  });

  it.each([
    "{",
    JSON.stringify({ key: "github.com/wrong/app" }),
    JSON.stringify({ key, extra: true }),
  ])("fails closed on corrupt or mismatched project metadata: %s", async (metadata) => {
    const note = await store.create("note", "Original");
    await writeFile(join(store.directory, "project.json"), metadata);
    await expect(store.list()).rejects.toThrow();
    await expect(store.read("note")).rejects.toThrow();
    await expect(store.create("new", "Changed")).rejects.toThrow();
    await expect(store.update("note", "Changed", note.revision)).rejects.toThrow();
    await expect(store.delete("note", note.revision)).rejects.toThrow();
    expect(await readFile(join(store.directory, "note.md"), "utf8")).toBe("Original");
    expect(await readdir(store.directory)).toEqual(["note.md", "project.json"]);
  });

  it("does not silently replace missing metadata in an existing populated project", async () => {
    await store.create("note", "Original");
    await unlink(join(store.directory, "project.json"));
    await expect(store.list()).rejects.toThrow("Missing project.json");
    await expect(store.create("new", "Changed")).rejects.toThrow("Missing project.json");
    await expect(store.delete("note", digest("Original"))).rejects.toThrow("Missing project.json");
    expect(await readdir(store.directory)).toEqual(["note.md"]);
  });

  it("never breaks an old lock automatically or changes a note when lock acquisition fails", async () => {
    const note = await store.create("note", "Original");
    const lock = join(store.directory, ".lock");
    await mkdir(lock);
    await utimes(lock, new Date(0), new Date(0));
    await expect(store.update("note", "Changed", note.revision)).rejects.toThrow(
      "all writers have stopped",
    );
    await expect(store.create("new", "Changed")).rejects.toThrow("Notes are locked");
    await expect(store.delete("note", note.revision)).rejects.toThrow("Notes are locked");
    expect((await lstat(lock)).isDirectory()).toBe(true);
    expect(await store.read("note")).toEqual(note);
  });

  it("does not follow or remove a symlink used in place of the lock", async () => {
    await store.create("note", "Original");
    const outside = join(temporary, "outside");
    await mkdir(outside);
    const lock = join(store.directory, ".lock");
    await symlink(outside, lock);
    await expect(store.create("new", "Changed")).rejects.toThrow("Notes are locked");
    await expect(store.delete("note", digest("Original"))).rejects.toThrow("Notes are locked");
    expect((await lstat(lock)).isSymbolicLink()).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(["delete", "update"] as const)(
    "keeps a single winner for simultaneous delete and %s from independent processes",
    async (operation) => {
      const original = await store.create("shared", "Original");
      const deletion = writer("delete", original.revision, "");
      const other = writer(operation, original.revision, "Updated");
      await Promise.all([deletion.ready, other.ready]);
      deletion.child.send("go");
      other.child.send("go");
      const outcomes = await Promise.all([deletion.result, other.result]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.find((outcome) => !outcome.ok)?.error).toMatch(/locked|conflict|not found/i);
      if (outcomes[0]!.ok || operation === "delete") {
        await expect(store.read("shared")).rejects.toThrow("Note not found");
        expect(await readdir(store.directory)).toEqual(["project.json"]);
      } else {
        expect((await store.read("shared")).body).toBe("Updated");
        expect(await readdir(store.directory)).toEqual(["project.json", "shared.md"]);
      }
    },
    10000,
  );

  it.each(["create", "update"] as const)(
    "keeps a single winner for simultaneous %s from independent processes",
    async (operation) => {
      const revision =
        operation === "update" ? (await store.create("shared", "Original")).revision : "";
      const first = writer(operation, revision, "Writer A");
      const second = writer(operation, revision, "Writer B");
      await Promise.all([first.ready, second.ready]);
      first.child.send("go");
      second.child.send("go");
      const outcomes = await Promise.all([first.result, second.result]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.find((outcome) => !outcome.ok)?.error).toMatch(
        /locked|conflict|already exists/i,
      );
      expect((await store.read("shared")).body).toBe(outcomes.find((outcome) => outcome.ok)?.body);
      expect(await readdir(store.directory)).toEqual(["project.json", "shared.md"]);
    },
    10000,
  );
});
