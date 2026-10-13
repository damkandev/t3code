// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { getPersona } from "./personas.ts";
import { listGroups, listSpaces, migrateLegacyLayout } from "./spaces.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
const tempRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "puntos-"));
  roots.push(root);
  return root;
};

describe("migrateLegacyLayout", () => {
  it("turns the single group into space and group General, keeping its project folder", () => {
    const root = tempRoot();
    const agentsDir = NodePath.join(root, "agents");
    NodeFS.mkdirSync(NodePath.join(agentsDir, "vale"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentsDir, "vale", "persona.md"),
      "---\nname: Vale\nmounts:\n  - /Users/x/App:/mnt/app:rw\n---\nEres Vale.\n",
    );
    NodeFS.writeFileSync(NodePath.join(root, "chat.jsonl"), '{"id":"m1"}\n');
    NodeFS.writeFileSync(NodePath.join(root, "members.json"), '{"vale":{"threadId":"t","seen":1}}');

    migrateLegacyLayout(root, [getPersona(agentsDir, "vale")!]);

    const spacesDir = NodePath.join(root, "spaces");
    expect(listSpaces(spacesDir)).toEqual([
      {
        id: "general",
        name: "General",
        memberIds: ["vale"],
        folders: [],
        dms: {},
        workdir: NodePath.join(root, "files"),
      },
    ]);
    expect(listGroups(spacesDir, "general")).toEqual([
      { id: "general", name: "General", memberIds: ["vale"] },
    ]);
    const group = NodePath.join(spacesDir, "general", "groups", "general");
    expect(NodeFS.readFileSync(NodePath.join(group, "chat.jsonl"), "utf8")).toBe('{"id":"m1"}\n');
    expect(NodeFS.existsSync(NodePath.join(group, "members.json"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(root, "chat.jsonl"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(agentsDir, "vale", "persona.md"), "utf8")).toContain(
      "  - /Users/x/App:rw\n",
    );

    // Runs once: a later space layout is left alone.
    NodeFS.writeFileSync(NodePath.join(root, "chat.jsonl"), "");
    migrateLegacyLayout(root, []);
    expect(listGroups(spacesDir, "general")[0]?.memberIds).toEqual(["vale"]);
  });

  it("gives a fresh install an empty General", () => {
    const root = tempRoot();
    migrateLegacyLayout(root, []);
    expect(listSpaces(NodePath.join(root, "spaces")).map((space) => space.memberIds)).toEqual([[]]);
  });
});
