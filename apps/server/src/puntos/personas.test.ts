import { describe, expect, it } from "vite-plus/test";

import { mountArgs } from "./docker.ts";
import {
  accentColorFor,
  parsePersona,
  serializePersona,
  serializeSkill,
  skillInstructions,
  validatePersona,
} from "./personas.ts";

const VALE = {
  name: "Vale",
  shape: "hexagon" as const,
  model: "sonnet",
  mounts: [
    { host: "/Users/x/App", rw: false },
    { host: "/Users/x/Docs", rw: true },
  ],
  prompt: "Eres Vale.\nRevisas todo.",
};

describe("puntos personas", () => {
  it("round-trips persona.md, including read-only and writable mounts", () => {
    expect(parsePersona(serializePersona(VALE))).toEqual(VALE);
  });

  it("reads mounts written with a container path, dropping it", () => {
    const legacy =
      "---\nname: Vale\nmounts:\n  - /Users/x/App:/mnt/app\n  - /Users/x/Docs:/mnt/docs:rw\n---\nhola";
    expect(parsePersona(legacy).mounts).toEqual(VALE.mounts);
  });

  it("treats a file without frontmatter as a bare prompt", () => {
    expect(parsePersona("  solo prompt  ")).toMatchObject({
      name: "",
      mounts: [],
      prompt: "solo prompt",
    });
  });

  it("rejects bad ids and folders the container could not mount at the same path", () => {
    expect(() => validatePersona({ ...VALE, id: "Vale!", mounts: [] })).toThrow(/id/);
    for (const host of ["relative/dir", "/a:b", "/does/not/exist"]) {
      expect(() => validatePersona({ ...VALE, id: "vale", mounts: [{ host, rw: false }] })).toThrow(
        /carpeta/i,
      );
    }
  });

  it("mounts every folder at its host path, once, read-only unless any source is writable", () => {
    const args = mountArgs(
      { id: "vale", ...VALE, dir: "/data/agents/vale", files: [] },
      {
        attachmentsDir: "/state/attachments",
        workdirs: ["/data/spaces/a/files", "/data/spaces/b/files"],
        folders: [
          { host: "/Users/x/App", rw: true },
          { host: "/Users/x/Empresa", rw: false },
        ],
      },
    );
    expect(args.filter((_, i) => i % 2 === 1)).toEqual([
      "puntos-vale-home:/home/agent",
      "/data/agents/vale/home:/data/agents/vale/home",
      "/data/agents/vale/files:/knowledge:ro",
      "/data/spaces/a/files:/data/spaces/a/files",
      "/data/spaces/b/files:/data/spaces/b/files",
      "/state/attachments:/state/attachments:ro",
      "/Users/x/App:/Users/x/App",
      "/Users/x/Docs:/Users/x/Docs",
      "/Users/x/Empresa:/Users/x/Empresa:ro",
    ]);
  });

  it("gives each member a stable #rrggbb accent, as provider instances require", () => {
    expect(accentColorFor("vale")).toMatch(/^#[0-9a-f]{6}$/);
    expect(accentColorFor("vale")).toBe(accentColorFor("vale"));
    expect(accentColorFor("vale")).not.toBe(accentColorFor("tomi"));
  });

  it("round-trips a SKILL.md body", () => {
    const skill = { name: "pr", description: "Abre PRs.", instructions: "1. Crea una rama." };
    expect(skillInstructions(serializeSkill(skill))).toBe(skill.instructions);
  });
});
