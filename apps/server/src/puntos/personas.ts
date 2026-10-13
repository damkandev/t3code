// @effect-diagnostics nodeBuiltinImport:off - Puntos keeps its small persona files on Node built-ins.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  PUNTOS_SHAPES,
  type PuntosAgent,
  type PuntosMount,
  type PuntosSkill,
} from "@t3tools/contracts";

export const ID_RE = /^[a-z0-9-]+$/;

type PersonaFields = Pick<PuntosAgent, "name" | "shape" | "model" | "mounts" | "prompt">;

/**
 * A persona on disk, `<agentsDir>/<id>/`:
 * - `persona.md`: frontmatter plus the personality prompt.
 * - `files/`: the member's knowledge, mounted read-only at `/knowledge`.
 * The spaces it belongs to list it in their `space.json` (see `spaces.ts`).
 * - `home/`: its Claude home (`CLAUDE_CONFIG_DIR`), with `skills/`, `CLAUDE.md` and `PUNTOS.md`.
 * - `claude`: the wrapper its provider instance runs instead of the Claude binary.
 */
export interface Persona extends PersonaFields {
  readonly id: string;
  readonly dir: string;
  readonly files: ReadonlyArray<string>;
}

export const homeDir = (persona: Pick<Persona, "dir">) => NodePath.join(persona.dir, "home");
export const skillsDir = (persona: Pick<Persona, "dir">) =>
  NodePath.join(homeDir(persona), "skills");
export const wrapperPath = (persona: Pick<Persona, "dir">) => NodePath.join(persona.dir, "claude");

// "host[:rw]" -> { host, rw }. Older files wrote "host:container[:rw]"; folders are now mounted
// at their host path, so the container part is ignored. Hosts cannot contain ":".
function parseMount(value: string): PuntosMount {
  const parts = value.split(":");
  return { host: parts[0] ?? "", rw: parts.at(-1) === "rw" };
}

/** Parses `persona.md`: minimal `key: value` frontmatter with `  - item` lists, then the prompt. */
export function parsePersona(text: string): PersonaFields {
  const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { name: "", shape: "circle", model: "", mounts: [], prompt: text.trim() };
  const meta: Record<string, string | string[]> = {};
  let key: string | null = null;
  for (const line of (match[1] ?? "").split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      const current = meta[key];
      meta[key] = [...(Array.isArray(current) ? current : []), (item[1] ?? "").trim()];
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv?.[1]) {
      key = kv[1];
      if (kv[2]) meta[key] = kv[2].trim();
    }
  }
  const text_ = (k: string) => (typeof meta[k] === "string" ? meta[k] : "");
  return {
    name: text_("name"),
    shape: PUNTOS_SHAPES.find((shape) => shape === text_("shape")) ?? "circle",
    model: text_("model"),
    mounts: (Array.isArray(meta.mounts) ? meta.mounts : []).map(parseMount),
    prompt: (match[2] ?? "").trim(),
  };
}

export function serializePersona({ name, shape, model, mounts, prompt }: PersonaFields): string {
  const lines = ["---", `name: ${name}`, `shape: ${shape}`, `model: ${model}`];
  if (mounts.length) {
    lines.push("mounts:");
    for (const m of mounts) lines.push(`  - ${m.host}${m.rw ? ":rw" : ""}`);
  }
  return `${lines.join("\n")}\n---\n${prompt.trim()}\n`;
}

export function validatePersona(input: PersonaFields & { readonly id: string }): void {
  if (!ID_RE.test(input.id)) {
    throw new Error("El id debe ser minúsculas, números y guiones (a-z, 0-9, -).");
  }
  for (const [label, value] of [
    ["nombre", input.name],
    ["modelo", input.model],
  ] as const) {
    if (/[\r\n]/.test(value)) throw new Error(`El ${label} es inválido (texto de una sola línea).`);
  }
  if (!input.name.trim()) throw new Error("El nombre es obligatorio.");
  if (!/^[\w.[\]-]+$/.test(input.model)) throw new Error("El modelo es inválido.");
  for (const m of input.mounts) validateFolder(m.host);
}

/** A host folder a container mounts at the same path. */
export function validateFolder(host: string): void {
  if (!NodePath.isAbsolute(host)) throw new Error(`La carpeta debe ser una ruta absoluta: ${host}`);
  if (/[:\r\n]/.test(host)) {
    throw new Error(`La carpeta no puede tener ":" ni saltos de línea: ${host}`);
  }
  if (!NodeFS.existsSync(host)) throw new Error(`La carpeta no existe: ${host}`);
}

export function getPersona(agentsDir: string, id: string): Persona | null {
  if (!ID_RE.test(id)) return null;
  const dir = NodePath.join(agentsDir, id);
  let text: string;
  try {
    text = NodeFS.readFileSync(NodePath.join(dir, "persona.md"), "utf8");
  } catch {
    return null;
  }
  let files: string[] = [];
  try {
    files = NodeFS.readdirSync(NodePath.join(dir, "files"), { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => f.name)
      .toSorted();
  } catch {}
  return { id, ...parsePersona(text), dir, files };
}

export function listPersonas(agentsDir: string): Persona[] {
  if (!NodeFS.existsSync(agentsDir)) return [];
  return NodeFS.readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_RE.test(d.name))
    .flatMap((d) => getPersona(agentsDir, d.name) ?? [])
    .toSorted((a, b) => (a.id < b.id ? -1 : 1));
}

export function savePersona(
  agentsDir: string,
  input: PersonaFields & { readonly id: string },
): Persona {
  validatePersona(input);
  const dir = NodePath.join(agentsDir, input.id);
  NodeFS.mkdirSync(NodePath.join(dir, "files"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "persona.md"),
    serializePersona({
      ...input,
      name: input.name.trim(),
      mounts: input.mounts.map((m) => ({ host: m.host, rw: m.rw })),
    }),
  );
  return getPersona(agentsDir, input.id)!;
}

export function deletePersona(agentsDir: string, id: string): void {
  if (!ID_RE.test(id)) throw new Error("El id es inválido.");
  NodeFS.rmSync(NodePath.join(agentsDir, id), { recursive: true, force: true });
}

/** Moves the pre-instance layout (`<dir>/skills`) into the member's Claude home. */
export function migratePersonaLayout(persona: Persona): void {
  const legacySkills = NodePath.join(persona.dir, "skills");
  NodeFS.mkdirSync(homeDir(persona), { recursive: true });
  if (NodeFS.existsSync(legacySkills) && !NodeFS.existsSync(skillsDir(persona))) {
    NodeFS.renameSync(legacySkills, skillsDir(persona));
  }
  NodeFS.mkdirSync(skillsDir(persona), { recursive: true });
}

/** Stable accent per member, as the `#rrggbb` provider instances accept. */
export function accentColorFor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  // HSL(hue, 55%, 62%) to RGB.
  const s = 0.55;
  const l = 0.62;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// --- skills: `<home>/skills/<name>/SKILL.md`; T3's `discoverClaudeSkills` lists them ---

export function serializeSkill({ name, description, instructions }: PuntosSkill): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${oneLine}\n---\n\n${instructions.trim()}\n`;
}

/** The body of a SKILL.md, without its frontmatter. */
export const skillInstructions = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .trim();

export function validateSkillName(name: string): void {
  if (!ID_RE.test(name)) {
    throw new Error("El nombre de la skill debe ser minúsculas, números y guiones (a-z, 0-9, -).");
  }
}
