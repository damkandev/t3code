// @effect-diagnostics nodeBuiltinImport:off - Puntos keeps its small space files on Node built-ins.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { PuntosMount } from "@t3tools/contracts";

import { ID_RE, type Persona, serializePersona } from "./personas.ts";

/**
 * A space on disk, `<spacesDir>/<id>/`:
 * - `space.json`: a `SpaceFile`.
 * - `files/`: its working folder (the T3 project root and cwd of its threads), unless `workdir`
 *   points elsewhere (the space migrated from the single-group layout keeps `<root>/files`).
 *   `.puntos/MEMORIA.md` inside it is the memory its members share.
 * - `groups/<groupId>/`: `group.json` (a `GroupFile`), `chat.jsonl` (the log, one `PuntosMessage`
 *   per line) and `members.json` (a `GroupMemo`).
 */
export interface SpaceFile {
  readonly id: string;
  readonly name: string;
  readonly memberIds: ReadonlyArray<string>;
  readonly folders: ReadonlyArray<PuntosMount>;
  /** Member id -> its DM thread. */
  readonly dms: Readonly<Record<string, string>>;
  readonly workdir: string;
}

export interface GroupFile {
  readonly id: string;
  readonly name: string;
  readonly memberIds: ReadonlyArray<string>;
}

/** Per member: its thread in the group and how much of the log it has already seen. */
export type GroupMemo = Record<string, { threadId: string | null; seen: number }>;

/** The space's shared memory, inside its working folder so every member's container mounts it. */
export const spaceMemoryPath = (space: Pick<SpaceFile, "workdir">) =>
  NodePath.join(space.workdir, ".puntos", "MEMORIA.md");

export const groupDir = (spacesDir: string, spaceId: string, groupId: string) =>
  NodePath.join(spacesDir, spaceId, "groups", groupId);

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const writeJson = (file: string, value: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const subdirs = (dir: string) => {
  try {
    return NodeFS.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
};

const byName = (a: { readonly name: string }, b: { readonly name: string }) =>
  a.name.localeCompare(b.name);

export function readSpace(spacesDir: string, id: string): SpaceFile | null {
  if (!ID_RE.test(id)) return null;
  const space = readJson<(SpaceFile & { readonly folder?: PuntosMount | null }) | null>(
    NodePath.join(spacesDir, id, "space.json"),
    null,
  );
  if (!space) return null;
  // Spaces saved before several company folders were allowed kept a single `folder`.
  const { folder, ...rest } = space;
  return { ...rest, folders: space.folders ?? (folder ? [folder] : []) };
}

export function listSpaces(spacesDir: string): SpaceFile[] {
  return subdirs(spacesDir)
    .flatMap((id) => readSpace(spacesDir, id) ?? [])
    .toSorted(byName);
}

export const writeSpace = (spacesDir: string, space: SpaceFile) =>
  writeJson(NodePath.join(spacesDir, space.id, "space.json"), space);

export function readGroup(spacesDir: string, spaceId: string, id: string): GroupFile | null {
  if (!ID_RE.test(spaceId) || !ID_RE.test(id)) return null;
  return readJson<GroupFile | null>(
    NodePath.join(groupDir(spacesDir, spaceId, id), "group.json"),
    null,
  );
}

export function listGroups(spacesDir: string, spaceId: string): GroupFile[] {
  return subdirs(NodePath.join(spacesDir, spaceId, "groups"))
    .flatMap((id) => readGroup(spacesDir, spaceId, id) ?? [])
    .toSorted(byName);
}

export const writeGroup = (spacesDir: string, spaceId: string, group: GroupFile) =>
  writeJson(NodePath.join(groupDir(spacesDir, spaceId, group.id), "group.json"), group);

export const writeMemo = (spacesDir: string, spaceId: string, groupId: string, memo: GroupMemo) =>
  writeJson(NodePath.join(groupDir(spacesDir, spaceId, groupId), "members.json"), memo);

/**
 * Before spaces, Puntos was one group: `<root>/chat.jsonl`, `<root>/members.json` and a T3
 * project rooted at `<root>/files`. That becomes space "general" with group "general", both with
 * every member; the space keeps `<root>/files` as its working folder so the existing project and
 * threads keep working. Persona mounts are rewritten without their old container path. Runs only
 * while `spaces/` is missing, so a fresh install gets the same empty "General".
 */
export function migrateLegacyLayout(root: string, personas: ReadonlyArray<Persona>): void {
  const spacesDir = NodePath.join(root, "spaces");
  if (NodeFS.existsSync(spacesDir)) return;
  const memberIds = personas.map((persona) => persona.id);
  const group = groupDir(spacesDir, "general", "general");
  NodeFS.mkdirSync(group, { recursive: true });
  for (const name of ["chat.jsonl", "members.json"]) {
    const legacy = NodePath.join(root, name);
    if (NodeFS.existsSync(legacy)) NodeFS.renameSync(legacy, NodePath.join(group, name));
  }
  writeGroup(spacesDir, "general", { id: "general", name: "General", memberIds });
  for (const persona of personas) {
    NodeFS.writeFileSync(NodePath.join(persona.dir, "persona.md"), serializePersona(persona));
  }
  writeSpace(spacesDir, {
    id: "general",
    name: "General",
    memberIds,
    folders: [],
    dms: {},
    workdir: NodePath.join(root, "files"),
  });
}
