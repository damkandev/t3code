// @effect-diagnostics nodeBuiltinImport:off - Puntos keeps its group log and persona files on Node built-ins.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type ChatAttachment,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PuntosError,
  type PuntosAgent,
  type RunId,
  type PuntosDirectory,
  type PuntosGithubStatus,
  type PuntosGroup,
  type PuntosGroupEvent,
  type PuntosMessage,
  type PuntosMount,
  type PuntosSkill,
  type PuntosSpace,
  ThreadId,
} from "@t3tools/contracts";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import {
  attachmentFileExtension,
  createAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AttachmentClaims from "../orchestration-v2/AttachmentClaims.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Docker from "./docker.ts";
import { memberInstructions } from "./instructions.ts";
import {
  accentColorFor,
  deletePersona,
  getPersona,
  homeDir,
  listPersonas,
  migratePersonaLayout,
  type Persona,
  savePersona,
  serializeSkill,
  skillInstructions,
  skillsDir,
  validateFolder,
  validateSkillName,
  wrapperPath,
} from "./personas.ts";
import {
  type GroupFile,
  type GroupMemo,
  groupDir,
  listGroups,
  listSpaces,
  migrateLegacyLayout,
  readGroup,
  readJson,
  readSpace,
  type SpaceFile,
  spaceMemoryPath,
  writeGroup,
  writeMemo,
  writeSpace,
} from "./spaces.ts";

const USER = process.env.PUNTOS_USER_NAME || "Damián";
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const TOKEN_SECRET = "puntos-claude-oauth-token";
const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** Group files (uploads, migrated files, member outboxes) live under this attachment segment. */
const GROUP_ATTACHMENTS = "puntos";
// ponytail: providers cap attachments per message; a member only gets the newest ones.
const MAX_ATTACHMENTS_PER_TURN = 8;
const ROUND_TIMEOUT_MS = 60 * 60_000;

export const instanceIdFor = (id: string) => ProviderInstanceId.make(`puntos-${id}`);
/** The member on the host's claude, for the user's own T3 code threads. */
export const codeInstanceIdFor = (id: string) => ProviderInstanceId.make(`puntos-${id}-code`);

/**
 * What a member's run posts to the group: its last non-empty assistant text (earlier text is
 * narration between tool calls), every attachment it sent, and the pages it published with
 * html_render.
 */
export function collectReply(
  records: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
  runId: RunId,
) {
  const replies = records.messages.filter((m) => m.role === "assistant" && m.runId === runId);
  return {
    text: replies.findLast((m) => m.text.trim())?.text.trim() ?? "",
    attachments: replies.flatMap((m) => m.attachments),
    renders: records.turnItems.flatMap((item) =>
      item.type === "dynamic_tool" && item.status === "completed" && item.runId === runId
        ? (htmlRenderFromToolItem(item) ?? [])
        : [],
    ),
  };
}

export class PuntosService extends Context.Service<
  PuntosService,
  {
    readonly subscribeDirectory: Stream.Stream<PuntosDirectory>;
    readonly subscribeGroup: (input: {
      readonly spaceId: string;
      readonly groupId: string;
    }) => Stream.Stream<PuntosGroupEvent, PuntosError>;
    readonly sendMessage: (input: {
      readonly spaceId: string;
      readonly groupId: string;
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }) => Effect.Effect<PuntosMessage, PuntosError>;
    readonly saveSpace: (input: {
      readonly id?: string;
      readonly name: string;
      readonly folders: ReadonlyArray<PuntosMount>;
    }) => Effect.Effect<PuntosSpace, PuntosError>;
    readonly deleteSpace: (id: string) => Effect.Effect<void, PuntosError>;
    readonly saveGroup: (input: {
      readonly spaceId: string;
      readonly id?: string;
      readonly name: string;
      readonly memberIds: ReadonlyArray<string>;
    }) => Effect.Effect<PuntosGroup, PuntosError>;
    readonly deleteGroup: (input: {
      readonly spaceId: string;
      readonly id: string;
    }) => Effect.Effect<void, PuntosError>;
    readonly openDirect: (input: {
      readonly spaceId: string;
      readonly agentId: string;
    }) => Effect.Effect<{ readonly threadId: string }, PuntosError>;
    readonly saveAgent: (
      input: Pick<PuntosAgent, "id" | "name" | "shape" | "model" | "mounts" | "prompt"> & {
        readonly spaceIds: ReadonlyArray<string>;
      },
    ) => Effect.Effect<PuntosAgent, PuntosError>;
    readonly deleteAgent: (id: string) => Effect.Effect<void, PuntosError>;
    readonly resetAgent: (id: string) => Effect.Effect<PuntosAgent, PuntosError>;
    readonly addAgentFiles: (
      id: string,
      attachments: ReadonlyArray<ChatAttachment>,
    ) => Effect.Effect<PuntosAgent, PuntosError>;
    readonly deleteAgentFile: (id: string, name: string) => Effect.Effect<PuntosAgent, PuntosError>;
    readonly setToken: (token: string) => Effect.Effect<void, PuntosError>;
    readonly githubStatus: (id: string) => Effect.Effect<PuntosGithubStatus, PuntosError>;
    readonly githubLogin: (
      id: string,
      scopes: ReadonlyArray<string>,
    ) => Effect.Effect<{ readonly code: string; readonly url: string }, PuntosError>;
    readonly githubLogout: (id: string) => Effect.Effect<void, PuntosError>;
    readonly saveSkill: (id: string, skill: PuntosSkill) => Effect.Effect<PuntosAgent, PuntosError>;
    readonly deleteSkill: (id: string, name: string) => Effect.Effect<PuntosAgent, PuntosError>;
    readonly listHostSkills: Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly description: string }>,
      PuntosError
    >;
    readonly importSkill: (id: string, name: string) => Effect.Effect<PuntosAgent, PuntosError>;
  }
>()("t3/puntos/PuntosService") {}

const isPuntosError = Schema.is(PuntosError);
const toPuntosError = (cause: unknown) =>
  isPuntosError(cause)
    ? cause
    : new PuntosError({
        message:
          typeof cause === "object" && cause !== null && "message" in cause
            ? String(cause.message)
            : String(cause),
      });
const fail = (message: string) => Effect.fail(new PuntosError({ message }));

function safeName(name: string): string {
  const base = NodePath.basename(name.replaceAll("\\", "/"));
  if (!base || base === "." || base === ".." || base.includes("\0")) {
    throw new Error("Nombre de archivo inválido.");
  }
  return base;
}

const readText = (file: string, fallback: string) => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
};

/** A space or group name: one non-empty line. */
function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error("El nombre es inválido.");
  return trimmed;
}

const ROUTER_SYSTEM = `Decides quién responde en un chat grupal. Elige solo a los miembros a quienes el último mensaje les concierne: por su rol, porque los nombran o aluden, o porque la conversación venía con ellos. Si el mensaje es para todos (saludo general, "¿qué opinan?"), elige a todos. Elige al menos uno: el más relevante.`;
const ROUTER_SCHEMA = JSON.stringify({
  type: "object",
  properties: { ids: { type: "array", items: { type: "string" } } },
  required: ["ids"],
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Legacy group messages stored file names from the old shared folder instead of attachments. */
interface LegacyMessage extends Omit<PuntosMessage, "attachments" | "renders" | "threadId"> {
  readonly files?: ReadonlyArray<string>;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const httpServer = yield* HttpServer.HttpServer;
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<
    | Effect.Services<ReturnType<typeof Docker.ensureContainer>>
    | Effect.Services<ReturnType<typeof AttachmentClaims.claimPendingAttachments>>
    | Effect.Services<ReturnType<typeof discoverClaudeSkills>>
  >();

  const root = NodePath.join(config.stateDir, "puntos");
  const agentsDir = NodePath.join(root, "agents");
  const spacesDir = NodePath.join(root, "spaces");
  const mcpPort = NetAddress.isInetAddress(httpServer.address) ? httpServer.address.port : null;
  NodeFS.mkdirSync(agentsDir, { recursive: true });
  migrateLegacyLayout(root, listPersonas(agentsDir));
  // The old per-container Claude sessions do not carry over; members re-read the whole log.
  NodeFS.rmSync(NodePath.join(root, "sessions.json"), { force: true });

  /** Copies a host file into T3's attachment store as a group attachment. */
  const storeGroupFile = (file: string, name: string): ChatAttachment | null => {
    const sizeBytes = NodeFS.statSync(file).size;
    const ext = attachmentFileExtension(name);
    const mimeType = hostPreviewMimeTypeFromExtension(ext) ?? "application/octet-stream";
    const isImage =
      imageMimeType({ name, mimeType }) !== null && sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
    if (sizeBytes < 1 || sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) return null;
    const id = createAttachmentId(GROUP_ATTACHMENTS, isImage ? undefined : ext);
    if (!id) return null;
    const attachment: ChatAttachment = isImage
      ? { type: "image", id, name, mimeType, sizeBytes }
      : { type: "file", id, name, mimeType, sizeBytes };
    const target = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
    if (!target) return null;
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.copyFileSync(file, target);
    return attachment;
  };

  // Groups are keyed `<spaceId>/<groupId>`; their logs and memos load on first use.
  const keyOf = (spaceId: string, groupId: string) => `${spaceId}/${groupId}`;
  const chats = new Map<string, PuntosMessage[]>();
  const memos = new Map<string, GroupMemo>();
  // ponytail: one round at a time per group; groups run in parallel, responders take turns.
  const busy = new Set<string>();

  /**
   * A group's log. Messages from before members were T3 threads point at files in the space's
   * working folder; they are moved into the attachment store once and the log is rewritten.
   */
  const chatOf = (space: SpaceFile, groupId: string) => {
    const key = keyOf(space.id, groupId);
    const cached = chats.get(key);
    if (cached) return cached;
    const file = NodePath.join(groupDir(spacesDir, space.id, groupId), "chat.jsonl");
    const legacy: LegacyMessage[] = readText(file, "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const chat: PuntosMessage[] = legacy.map((m) => ({
      id: m.id,
      ts: m.ts,
      author: m.author,
      text: m.text,
      renders: [],
      threadId: null,
      ...("renders" in m ? (m as PuntosMessage) : {}),
      attachments:
        m.attachments ??
        (m.files ?? []).flatMap((name) => {
          const stored = NodePath.join(space.workdir, name);
          return NodeFS.existsSync(stored) ? (storeGroupFile(stored, name) ?? []) : [];
        }),
    }));
    if (legacy.some((m) => m.attachments === undefined)) {
      NodeFS.writeFileSync(file, chat.map((m) => `${JSON.stringify(m)}\n`).join(""));
    }
    chats.set(key, chat);
    return chat;
  };

  const memoOf = (spaceId: string, groupId: string) => {
    const key = keyOf(spaceId, groupId);
    const cached = memos.get(key);
    if (cached) return cached;
    const memo = readJson<GroupMemo>(
      NodePath.join(groupDir(spacesDir, spaceId, groupId), "members.json"),
      {},
    );
    memos.set(key, memo);
    return memo;
  };
  const saveMemo = (spaceId: string, groupId: string) =>
    writeMemo(spacesDir, spaceId, groupId, memoOf(spaceId, groupId));

  // The token lives in T3's secret store and is handed to each member's provider instance.
  const legacyTokenFile = NodePath.join(root, "token");
  let token =
    process.env[TOKEN_ENV] ||
    Option.match(yield* secrets.get(TOKEN_SECRET).pipe(Effect.orElseSucceed(() => Option.none())), {
      onNone: () => "",
      onSome: (bytes) => new TextDecoder().decode(bytes),
    }) ||
    readText(legacyTokenFile, "").trim();
  if (NodeFS.existsSync(legacyTokenFile) && token) {
    yield* secrets.set(TOKEN_SECRET, new TextEncoder().encode(token)).pipe(Effect.ignore);
    NodeFS.rmSync(legacyTokenFile, { force: true });
  }

  const directoryEvents = yield* PubSub.unbounded<PuntosDirectory>();
  const groupEvents = yield* PubSub.unbounded<{
    readonly key: string;
    readonly event: PuntosGroupEvent;
  }>();
  const emitGroup = (key: string, event: PuntosGroupEvent) =>
    PubSub.publishUnsafe(groupEvents, { key, event });
  const personas = () => listPersonas(agentsDir);
  const spacesOf = (memberId: string) =>
    listSpaces(spacesDir).filter((space) => space.memberIds.includes(memberId));
  const groupMembers = (group: GroupFile) =>
    group.memberIds.flatMap((id) => getPersona(agentsDir, id) ?? []);

  const memberSkills = (persona: Persona) =>
    discoverClaudeSkills({ homePath: homeDir(persona) }).pipe(
      Effect.map((skills) =>
        skills
          .filter((skill) => skill.scope === "user")
          .map((skill) => ({
            name: skill.name,
            description: skill.description ?? "",
            instructions: skillInstructions(readText(skill.path, "")),
          })),
      ),
    );

  const publicAgent = (persona: Persona, spaces: ReadonlyArray<SpaceFile>) =>
    Effect.gen(function* () {
      const instance = (yield* settings.getSettings).providerInstances[instanceIdFor(persona.id)];
      const agent: PuntosAgent = {
        id: persona.id,
        name: persona.name,
        shape: persona.shape,
        model: persona.model,
        mounts: persona.mounts,
        prompt: persona.prompt,
        files: persona.files,
        skills: yield* memberSkills(persona),
        instanceId: instanceIdFor(persona.id),
        codeInstanceId: codeInstanceIdFor(persona.id),
        spaceIds: spaces
          .filter((space) => space.memberIds.includes(persona.id))
          .map((space) => space.id),
        accentColor: instance?.accentColor ?? accentColorFor(persona.id),
      };
      return agent;
    }).pipe(Effect.provide(context));

  const publicGroup = (spaceId: string, group: GroupFile): PuntosGroup => ({
    id: group.id,
    name: group.name,
    memberIds: group.memberIds,
    busy: busy.has(keyOf(spaceId, group.id)),
    threads: Object.fromEntries(
      Object.entries(memoOf(spaceId, group.id)).flatMap(([id, memo]) =>
        memo.threadId ? [[id, memo.threadId]] : [],
      ),
    ),
  });

  const publicSpace = (space: SpaceFile): PuntosSpace => ({
    id: space.id,
    name: space.name,
    memberIds: space.memberIds,
    folders: space.folders,
    dms: space.dms,
    groups: listGroups(spacesDir, space.id).map((group) => publicGroup(space.id, group)),
  });

  const directory = Effect.gen(function* () {
    const spaces = listSpaces(spacesDir);
    const result: PuntosDirectory = {
      spaces: spaces.map(publicSpace),
      agents: yield* Effect.forEach(personas(), (persona) => publicAgent(persona, spaces)),
      hasToken: token !== "",
    };
    return result;
  });
  const emitDirectory = directory.pipe(
    Effect.tap((current) => PubSub.publish(directoryEvents, current)),
    Effect.ignore,
  );

  const personaOrFail = (id: string) => {
    const persona = getPersona(agentsDir, id);
    return persona ? Effect.succeed(persona) : fail("Miembro no encontrado.");
  };
  const spaceOrFail = (id: string) => {
    const space = readSpace(spacesDir, id);
    return space ? Effect.succeed(space) : fail("Espacio no encontrado.");
  };
  const groupOrFail = (spaceId: string, groupId: string) =>
    Effect.flatMap(spaceOrFail(spaceId), (space) => {
      const group = readGroup(spacesDir, spaceId, groupId);
      return group ? Effect.succeed({ space, group }) : fail("Grupo no encontrado.");
    });
  const idle = (key: string) =>
    Effect.suspend(() =>
      busy.has(key) ? fail("Hay una ronda en curso en este grupo.") : Effect.void,
    );
  /** Fails while a group the member belongs to is in a round. */
  const memberIdle = (id: string) =>
    Effect.suspend(() =>
      listSpaces(spacesDir).some((space) =>
        listGroups(spacesDir, space.id).some(
          (group) => group.memberIds.includes(id) && busy.has(keyOf(space.id, group.id)),
        ),
      )
        ? fail("Hay una ronda en curso con este miembro.")
        : Effect.void,
    );
  const needToken = Effect.suspend(() =>
    token ? Effect.void : fail("Falta el token de Claude: corre `claude setup-token` y pégalo."),
  );

  /** The space's T3 project, rooted at its working folder. */
  const ensureProject = (space: SpaceFile) =>
    Effect.gen(function* () {
      const existing = yield* projects.getByWorkspaceRoot(space.workdir);
      if (Option.isSome(existing)) return existing.value.id;
      const project = yield* projects.create({
        commandId: CommandId.make(`puntos:project:${NodeCrypto.randomUUID()}`),
        projectId: ProjectId.make(NodeCrypto.randomUUID()),
        title: space.name,
        workspaceRoot: space.workdir,
        createWorkspaceRootIfMissing: true,
      });
      return project.id;
    });

  const writeInstructions = (persona: Persona, all: ReadonlyArray<Persona>) => {
    const home = homeDir(persona);
    const names = new Map(all.map((p) => [p.id, p.name]));
    NodeFS.mkdirSync(home, { recursive: true });
    const notes = NodePath.join(home, "CLAUDE.md");
    NodeFS.writeFileSync(
      NodePath.join(home, "PUNTOS.md"),
      memberInstructions({
        persona,
        spaces: spacesOf(persona.id).map((space) => {
          const memory = spaceMemoryPath(space);
          if (!NodeFS.existsSync(memory)) {
            NodeFS.mkdirSync(NodePath.dirname(memory), { recursive: true });
            NodeFS.writeFileSync(memory, "# Memoria compartida del espacio\n");
          }
          return {
            name: space.name,
            workdir: space.workdir,
            folders: space.folders,
            memory,
            members: space.memberIds.flatMap((id) => names.get(id) ?? []),
          };
        }),
        user: USER,
        outboxDir: Docker.outboxDir(persona),
        notesPath: notes,
        hostKnowledgeDir: NodePath.join(persona.dir, "files"),
      }),
    );
    const current = readText(notes, "");
    if (!current.startsWith("@PUNTOS.md")) NodeFS.writeFileSync(notes, `@PUNTOS.md\n\n${current}`);
  };
  const writeAllInstructions = () => {
    const all = personas();
    for (const persona of all) writeInstructions(persona, all);
  };

  /**
   * Points the member's two Claude provider instances at its home: the container one (through its
   * docker-exec wrapper) for Puntos threads, and the `-code` one, the host's own claude, so coding
   * agents in the user's normal T3 threads can consult the member in their project folder.
   */
  const syncInstance = (persona: Persona, options: { readonly force?: boolean } = {}) =>
    Effect.gen(function* () {
      const current = (yield* settings.getSettings).providerInstances;
      const tokenEnv = token ? [{ name: TOKEN_ENV, value: token, sensitive: true }] : [];
      const instances = [
        {
          instanceId: instanceIdFor(persona.id),
          displayName: persona.name,
          environment: tokenEnv,
          config: { binaryPath: wrapperPath(persona), homePath: homeDir(persona) },
        },
        {
          instanceId: codeInstanceIdFor(persona.id),
          displayName: `${persona.name} · código`,
          // The container wrapper sets this itself; on the host the home's notes are the memory.
          environment: [
            ...tokenEnv,
            { name: "CLAUDE_CODE_DISABLE_AUTO_MEMORY", value: "1", sensitive: false },
          ],
          config: { homePath: homeDir(persona) },
        },
      ];
      const accentColor =
        current[instanceIdFor(persona.id)]?.accentColor ?? accentColorFor(persona.id);
      for (const { instanceId, displayName, environment, config: instanceConfig } of instances) {
        const existing = current[instanceId];
        const names = (existing?.environment ?? []).map((entry) => entry.name);
        if (
          !options.force &&
          existing?.displayName === displayName &&
          existing.accentColor === accentColor &&
          JSON.stringify(existing.config) === JSON.stringify(instanceConfig) &&
          JSON.stringify(names) === JSON.stringify(environment.map((entry) => entry.name))
        ) {
          continue;
        }
        yield* settings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: CLAUDE_DRIVER,
            displayName,
            accentColor,
            enabled: true,
            ...(environment.length ? { environment } : {}),
            config: instanceConfig,
          },
        });
      }
    });

  /**
   * Container, wrapper, notes and provider instance: everything a member needs to answer. The
   * container mounts the working and company folders of every space it belongs to.
   */
  const prepareMember = (persona: Persona) =>
    Effect.gen(function* () {
      migratePersonaLayout(persona);
      Docker.writeWrapper(persona);
      const spaces = spacesOf(persona.id);
      yield* Docker.ensureContainer(
        persona,
        {
          attachmentsDir: config.attachmentsDir,
          workdirs: spaces.map((space) => space.workdir),
          folders: spaces.flatMap((space) => space.folders),
        },
        mcpPort,
      );
      yield* syncInstance(persona);
    }).pipe(Effect.provide(context));

  /** Re-mounts after membership or folders changed, without making the caller wait on Docker. */
  const prepareInBackground = (ids: ReadonlyArray<string>) =>
    Effect.forEach(
      ids.flatMap((id) => getPersona(agentsDir, id) ?? []),
      (persona) => prepareMember(persona).pipe(Effect.ignore),
      { concurrency: 2, discard: true },
    ).pipe(Effect.forkIn(scope), Effect.asVoid);

  const dispatchThread = (type: "thread.archive" | "thread.delete", threadId: string) =>
    threads
      .dispatch({
        type,
        commandId: CommandId.make(`puntos:${type}:${NodeCrypto.randomUUID()}`),
        threadId: ThreadId.make(threadId),
      })
      .pipe(Effect.ignore);

  /**
   * Archives or deletes every thread the member has (group threads and DMs) and forgets them, so
   * its next turn starts a new thread that re-reads the log. With `leave` it also drops the member
   * from every space and group.
   */
  const releaseMember = (id: string, type: "thread.archive" | "thread.delete", leave: boolean) =>
    Effect.gen(function* () {
      const released: string[] = [];
      for (const space of listSpaces(spacesDir)) {
        for (const group of listGroups(spacesDir, space.id)) {
          const memo = memoOf(space.id, group.id);
          const threadId = memo[id]?.threadId;
          if (threadId) released.push(threadId);
          if (memo[id]) {
            delete memo[id];
            saveMemo(space.id, group.id);
          }
          if (leave && group.memberIds.includes(id)) {
            writeGroup(spacesDir, space.id, {
              ...group,
              memberIds: group.memberIds.filter((m) => m !== id),
            });
          }
        }
        const { [id]: dm, ...dms } = space.dms;
        if (dm) released.push(dm);
        writeSpace(spacesDir, {
          ...space,
          dms,
          memberIds: leave ? space.memberIds.filter((m) => m !== id) : space.memberIds,
        });
      }
      yield* Effect.forEach(released, (threadId) => dispatchThread(type, threadId), {
        discard: true,
      });
    });

  const addMessage = (
    space: SpaceFile,
    groupId: string,
    author: string,
    text: string,
    extra: Partial<Pick<PuntosMessage, "attachments" | "renders" | "threadId">> = {},
  ) => {
    const message: PuntosMessage = {
      id: NodeCrypto.randomUUID(),
      ts: Date.now(),
      author,
      text,
      attachments: extra.attachments ?? [],
      renders: extra.renders ?? [],
      threadId: extra.threadId ?? null,
    };
    chatOf(space, groupId).push(message);
    NodeFS.appendFileSync(
      NodePath.join(groupDir(spacesDir, space.id, groupId), "chat.jsonl"),
      `${JSON.stringify(message)}\n`,
    );
    emitGroup(keyOf(space.id, groupId), { _tag: "message", message });
    return message;
  };

  // Moves what the member left in its outbox into the attachment store, as its reply's files.
  // ponytail: one outbox per member, so a member answering two groups at once can mix files up.
  const collectOutbox = (persona: Persona) => {
    const outbox = Docker.outboxDir(persona);
    let entries: NodeFS.Dirent[] = [];
    try {
      entries = NodeFS.readdirSync(outbox, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile())
      .flatMap((entry) => {
        const file = NodePath.join(outbox, entry.name);
        const attachment = storeGroupFile(file, safeName(entry.name));
        NodeFS.rmSync(file, { force: true });
        return attachment ? [attachment] : [];
      });
  };

  const formatMessage = (m: PuntosMessage) => {
    const persona = m.author === "user" ? null : getPersona(agentsDir, m.author);
    const who = m.author === "user" ? USER : persona ? persona.name : m.author;
    return [
      `[${who}]: ${m.text}`,
      ...m.renders.map((render) => `[compartió en vivo: ${render.title}]`),
    ].join("\n");
  };

  // A Haiku picks responders when nobody was @mentioned; on failure everyone answers.
  // ponytail: one call per round, through the first member's container so the host needs no claude.
  const pickResponders = (all: Persona[], chat: ReadonlyArray<PuntosMessage>) =>
    Effect.gen(function* () {
      const first = all[0];
      if (all.length <= 1 || !first) return all;
      const list = all
        .map((a) => `- ${a.id}: ${a.name}. ${a.prompt.slice(0, 300).replace(/\s+/g, " ")}`)
        .join("\n");
      const prompt = `Miembros:\n${list}\n\nConversación reciente:\n${chat.slice(-12).map(formatMessage).join("\n\n")}\n\n¿Qué miembros deberían responder al último mensaje de ${USER}?`;
      const output = (yield* Docker.runClaudeJson(first, {
        prompt,
        systemPrompt: ROUTER_SYSTEM,
        schema: ROUTER_SCHEMA,
        model: "haiku",
        token,
      })) as { ids?: unknown } | undefined;
      const ids = Array.isArray(output?.ids) ? output.ids : [];
      const picked = all.filter((a) => ids.includes(a.id));
      return picked.length ? picked : all;
    }).pipe(
      Effect.provide(context),
      Effect.orElseSucceed(() => all),
    );

  const mentioned = (text: string, all: Persona[]) =>
    all.filter((a) =>
      [a.id, a.name].some((k) =>
        new RegExp(`@${escapeRe(k)}(?![\\p{L}\\p{N}_-])`, "iu").test(text),
      ),
    );

  /**
   * Sends the member what it has not seen of the group as a turn in its group thread, waits for
   * the run, and posts its final text, attachments and html_render pages to the group.
   * Members answer one after another, so the replies posted earlier in the round are part of
   * what this member reads.
   */
  const answer = (persona: Persona, space: SpaceFile, group: GroupFile, projectId: ProjectId) =>
    Effect.gen(function* () {
      const chat = chatOf(space, group.id);
      const memo = memoOf(space.id, group.id);
      const current = memo[persona.id] ?? { threadId: null, seen: 0 };
      const seen = chat.length;
      const fresh = chat.slice(current.seen).filter((m) => m.author !== persona.id);
      const text = [`Grupo «${group.name}» en «${space.name}»`, ...fresh.map(formatMessage)].join(
        "\n\n",
      );
      const attachments = fresh.flatMap((m) => m.attachments).slice(-MAX_ATTACHMENTS_PER_TURN);
      const modelSelection: ModelSelection = {
        instanceId: instanceIdFor(persona.id),
        model: persona.model || "sonnet",
      };
      const commandId = CommandId.make(`puntos:${NodeCrypto.randomUUID()}`);
      const messageId = MessageId.make(`puntos-message:${NodeCrypto.randomUUID()}`);
      const provenance = { createdBy: "system", creationSource: "server" } as const;

      let threadId: ThreadId;
      let runId;
      if (current.threadId === null) {
        const launched = yield* launches.launch({
          commandId,
          projectId,
          title: `${group.name} · ${persona.name}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId, text, attachments },
          ...provenance,
        });
        threadId = launched.threadId;
        runId = launched.projection.runs.at(-1)?.id;
        memo[persona.id] = { threadId, seen: current.seen };
        saveMemo(space.id, group.id);
        yield* emitDirectory;
      } else {
        threadId = ThreadId.make(current.threadId);
        const sent = yield* threads.sendToThread({
          projectId,
          commandId,
          threadId,
          messageId,
          text,
          attachments,
          modelSelection,
          // Never interrupts what the user started in the member's thread directly.
          mode: "queue",
          ...provenance,
        });
        runId = sent.run.id;
      }

      const waited = yield* threads.waitForThread({
        projectId,
        threadId,
        ...(runId === undefined ? {} : { runId }),
        timeoutMs: ROUND_TIMEOUT_MS,
      });
      const run = waited.run;
      if (waited.timedOut || !run) return yield* fail("No terminó a tiempo.");
      if (run.status !== "completed") return yield* fail(`Su turno terminó como ${run.status}.`);

      const records = yield* threads.getProjectThreadRecords(
        { projectId, threadId },
        ["messages", "turnItems"],
        { messageRunIds: [run.id], turnItemRunIds: [run.id] },
      );
      const reply = collectReply(records, run.id);
      const files = [...reply.attachments, ...collectOutbox(persona)];
      if (reply.text || files.length || reply.renders.length) {
        addMessage(space, group.id, persona.id, reply.text, {
          attachments: files,
          renders: reply.renders,
          threadId,
        });
      }
      memo[persona.id] = { threadId, seen };
      saveMemo(space.id, group.id);
    });

  /**
   * Responders answer in turn, each in its own thread, so each one reads what the previous ones
   * said; the group is busy until the last one ends.
   */
  const runRound = (space: SpaceFile, group: GroupFile, responders: Effect.Effect<Persona[]>) => {
    const key = keyOf(space.id, group.id);
    return Effect.gen(function* () {
      const projectId = yield* ensureProject(space);
      yield* Effect.forEach(
        yield* responders,
        (persona) =>
          prepareMember(persona).pipe(
            Effect.andThen(answer(persona, space, group, projectId)),
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                emitGroup(key, {
                  _tag: "error",
                  agentId: persona.id,
                  error: toPuntosError(Cause.squash(cause)).message,
                }),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          emitGroup(key, { _tag: "error", agentId: "", error: toPuntosError(error).message }),
        ),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          busy.delete(key);
          emitGroup(key, { _tag: "status", busy: false });
          return emitDirectory;
        }),
      ),
    );
  };

  /** Claims T3 pending uploads into the group attachment segment. */
  const claimGroupAttachments = (attachments: ReadonlyArray<ChatAttachment>) =>
    AttachmentClaims.claimPendingAttachments({ threadId: GROUP_ATTACHMENTS, attachments }).pipe(
      Effect.map((claimed) => claimed.attachments),
      Effect.provide(context),
    );

  const agentResult = (id: string) =>
    Effect.gen(function* () {
      yield* emitDirectory;
      return yield* publicAgent(yield* personaOrFail(id), listSpaces(spacesDir));
    });

  // Members created before they were provider instances (or after a server restart, when the MCP
  // port may have moved) are brought up in the background so startup never waits on Docker.
  yield* Effect.gen(function* () {
    writeAllInstructions();
    yield* Effect.forEach(personas(), (persona) => prepareMember(persona).pipe(Effect.ignore), {
      concurrency: 2,
      discard: true,
    });
    yield* emitDirectory;
  }).pipe(Effect.forkIn(scope));

  const mapped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(toPuntosError));
  const attempt = <A>(fn: () => A) => Effect.try({ try: fn, catch: toPuntosError });

  return PuntosService.of({
    subscribeDirectory: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(directoryEvents);
        const snapshot = yield* directory;
        return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
      }).pipe(Effect.orDie),
    ),
    subscribeGroup: ({ spaceId, groupId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { space } = yield* groupOrFail(spaceId, groupId);
          const key = keyOf(spaceId, groupId);
          const subscription = yield* PubSub.subscribe(groupEvents);
          const snapshot: PuntosGroupEvent = {
            _tag: "snapshot",
            messages: [...chatOf(space, groupId)],
            busy: busy.has(key),
          };
          return Stream.concat(
            Stream.make(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((entry) => entry.key === key),
              Stream.map((entry) => entry.event),
            ),
          );
        }),
      ),
    sendMessage: ({ spaceId, groupId, text, attachments }) =>
      mapped(
        Effect.gen(function* () {
          if (!text.trim() && !attachments.length) return yield* fail("Mensaje vacío.");
          const { space, group } = yield* groupOrFail(spaceId, groupId);
          const key = keyOf(spaceId, groupId);
          yield* idle(key);
          yield* needToken;
          const members = groupMembers(group);
          if (!members.length) return yield* fail("Agrega un miembro al grupo primero.");
          const claimed = yield* claimGroupAttachments(attachments);
          // Checked again: another message may have started a round while uploads were claimed.
          yield* idle(key);
          busy.add(key);
          const message = addMessage(space, groupId, "user", text, {
            attachments: claimed,
          });
          emitGroup(key, { _tag: "status", busy: true });
          yield* emitDirectory;
          const named = mentioned(text, members);
          yield* runRound(
            space,
            group,
            named.length ? Effect.succeed(named) : pickResponders(members, chatOf(space, groupId)),
          ).pipe(Effect.forkIn(scope));
          return message;
        }),
      ),
    saveSpace: ({ id, name, folders }) =>
      mapped(
        Effect.gen(function* () {
          const title = yield* attempt(() => validateName(name));
          yield* attempt(() => folders.forEach((folder) => validateFolder(folder.host)));
          const existing = id === undefined ? null : yield* spaceOrFail(id);
          const spaceId = existing?.id ?? NodeCrypto.randomUUID();
          const space: SpaceFile = existing
            ? { ...existing, name: title, folders }
            : {
                id: spaceId,
                name: title,
                memberIds: [],
                folders,
                dms: {},
                workdir: NodePath.join(spacesDir, spaceId, "files"),
              };
          yield* attempt(() => NodeFS.mkdirSync(space.workdir, { recursive: true }));
          const projectId = yield* ensureProject(space);
          if (existing && existing.name !== title) {
            yield* projects
              .update({
                commandId: CommandId.make(`puntos:project:${NodeCrypto.randomUUID()}`),
                projectId,
                title,
              })
              .pipe(Effect.ignore);
          }
          yield* attempt(() => writeSpace(spacesDir, space));
          if (existing) {
            writeAllInstructions();
            if (JSON.stringify(existing.folders) !== JSON.stringify(folders)) {
              yield* prepareInBackground(space.memberIds);
            }
          }
          yield* emitDirectory;
          return publicSpace(space);
        }),
      ),
    // The working folder and the T3 project stay, with the space's threads archived in it.
    deleteSpace: (id) =>
      mapped(
        Effect.gen(function* () {
          const space = yield* spaceOrFail(id);
          const groups = listGroups(spacesDir, id);
          if (groups.some((group) => busy.has(keyOf(id, group.id)))) {
            return yield* fail("Hay una ronda en curso en este espacio.");
          }
          const onlyHere = space.memberIds
            .flatMap((memberId) => getPersona(agentsDir, memberId) ?? [])
            .filter((persona) => spacesOf(persona.id).length === 1);
          if (onlyHere.length) {
            return yield* fail(
              `${onlyHere.map((p) => p.name).join(", ")} solo está en este espacio: muévelo a otro o elimínalo primero.`,
            );
          }
          const released = [
            ...groups.flatMap((group) =>
              Object.values(memoOf(id, group.id)).flatMap((memo) => memo.threadId ?? []),
            ),
            ...Object.values(space.dms),
          ];
          yield* Effect.forEach(
            released,
            (threadId) => dispatchThread("thread.archive", threadId),
            {
              discard: true,
            },
          );
          yield* attempt(() => {
            NodeFS.rmSync(NodePath.join(spacesDir, id, "groups"), { recursive: true, force: true });
            NodeFS.rmSync(NodePath.join(spacesDir, id, "space.json"), { force: true });
          });
          for (const group of groups) {
            chats.delete(keyOf(id, group.id));
            memos.delete(keyOf(id, group.id));
          }
          writeAllInstructions();
          yield* prepareInBackground(space.memberIds);
          yield* emitDirectory;
        }),
      ),
    saveGroup: ({ spaceId, id, name, memberIds }) =>
      mapped(
        Effect.gen(function* () {
          const space = yield* spaceOrFail(spaceId);
          const title = yield* attempt(() => validateName(name));
          if (id !== undefined && !readGroup(spacesDir, spaceId, id)) {
            return yield* fail("Grupo no encontrado.");
          }
          if (memberIds.some((memberId) => !space.memberIds.includes(memberId))) {
            return yield* fail("Todos los miembros del grupo deben estar en el espacio.");
          }
          const group: GroupFile = {
            id: id ?? NodeCrypto.randomUUID(),
            name: title,
            memberIds: [...new Set(memberIds)],
          };
          yield* attempt(() => writeGroup(spacesDir, spaceId, group));
          yield* emitDirectory;
          return publicGroup(spaceId, group);
        }),
      ),
    deleteGroup: ({ spaceId, id }) =>
      mapped(
        Effect.gen(function* () {
          yield* groupOrFail(spaceId, id);
          const key = keyOf(spaceId, id);
          yield* idle(key);
          const released = Object.values(memoOf(spaceId, id)).flatMap(
            (memo) => memo.threadId ?? [],
          );
          yield* Effect.forEach(
            released,
            (threadId) => dispatchThread("thread.archive", threadId),
            {
              discard: true,
            },
          );
          yield* attempt(() =>
            NodeFS.rmSync(groupDir(spacesDir, spaceId, id), { recursive: true, force: true }),
          );
          chats.delete(key);
          memos.delete(key);
          yield* emitDirectory;
        }),
      ),
    // A DM is a plain T3 thread with the member in the space's project; no Puntos log.
    openDirect: ({ spaceId, agentId }) =>
      mapped(
        Effect.gen(function* () {
          const space = yield* spaceOrFail(spaceId);
          if (!space.memberIds.includes(agentId)) {
            return yield* fail("El miembro no está en este espacio.");
          }
          const persona = yield* personaOrFail(agentId);
          const existing = space.dms[agentId];
          if (existing) {
            const shell = yield* threads
              .getThreadShell(ThreadId.make(existing))
              .pipe(Effect.orElseSucceed(() => null));
            if (shell && shell.archivedAt === null) return { threadId: existing };
          }
          yield* needToken;
          yield* prepareMember(persona);
          const launched = yield* launches.launch({
            commandId: CommandId.make(`puntos:dm:${NodeCrypto.randomUUID()}`),
            projectId: yield* ensureProject(space),
            title: `DM · ${persona.name}`,
            modelSelection: {
              instanceId: instanceIdFor(persona.id),
              model: persona.model || "sonnet",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            createdBy: "system",
            creationSource: "server",
          });
          // Re-read: the space may have changed while the thread was launching.
          const latest = readSpace(spacesDir, spaceId) ?? space;
          writeSpace(spacesDir, {
            ...latest,
            dms: { ...latest.dms, [agentId]: launched.threadId },
          });
          yield* emitDirectory;
          return { threadId: launched.threadId };
        }),
      ),
    saveAgent: ({ spaceIds, ...input }) =>
      mapped(
        Effect.gen(function* () {
          if (!spaceIds.length) return yield* fail("Elige al menos un espacio.");
          yield* Effect.forEach(spaceIds, spaceOrFail, { discard: true });
          const persona = yield* attempt(() => savePersona(agentsDir, input));
          for (const space of listSpaces(spacesDir)) {
            const wanted = spaceIds.includes(space.id);
            if (wanted === space.memberIds.includes(persona.id)) continue;
            writeSpace(spacesDir, {
              ...space,
              memberIds: wanted
                ? [...space.memberIds, persona.id]
                : space.memberIds.filter((m) => m !== persona.id),
            });
            if (wanted) continue;
            // Leaving a space leaves its groups; its threads stay in case it comes back.
            for (const group of listGroups(spacesDir, space.id)) {
              if (!group.memberIds.includes(persona.id)) continue;
              writeGroup(spacesDir, space.id, {
                ...group,
                memberIds: group.memberIds.filter((m) => m !== persona.id),
              });
            }
          }
          writeAllInstructions();
          yield* prepareMember(persona);
          return yield* agentResult(persona.id);
        }),
      ),
    deleteAgent: (id) =>
      mapped(
        Effect.gen(function* () {
          yield* personaOrFail(id);
          yield* memberIdle(id);
          yield* Docker.removeContainer(id, { wipeHome: true }).pipe(Effect.provide(context));
          yield* releaseMember(id, "thread.delete", true);
          for (const instanceId of [instanceIdFor(id), codeInstanceIdFor(id)]) {
            yield* settings.updateProviderInstance({ operation: "remove", instanceId });
          }
          yield* attempt(() => deletePersona(agentsDir, id));
          writeAllInstructions();
          yield* emitDirectory;
        }),
      ),
    // A fresh computer and fresh threads; the old ones stay archived as history.
    resetAgent: (id) =>
      mapped(
        Effect.gen(function* () {
          const persona = yield* personaOrFail(id);
          yield* memberIdle(id);
          yield* Docker.removeContainer(id, { wipeHome: true }).pipe(Effect.provide(context));
          yield* releaseMember(id, "thread.archive", false);
          NodeFS.rmSync(NodePath.join(homeDir(persona), "CLAUDE.md"), { force: true });
          writeAllInstructions();
          yield* prepareMember(persona);
          return yield* agentResult(id);
        }),
      ),
    addAgentFiles: (id, attachments) =>
      mapped(
        Effect.gen(function* () {
          const persona = yield* personaOrFail(id);
          const claimed = yield* claimGroupAttachments(attachments);
          yield* attempt(() => {
            NodeFS.mkdirSync(NodePath.join(persona.dir, "files"), { recursive: true });
            for (const attachment of claimed) {
              const stored = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              if (!stored) continue;
              NodeFS.renameSync(
                stored,
                NodePath.join(persona.dir, "files", safeName(attachment.name)),
              );
            }
          });
          return yield* agentResult(id);
        }),
      ),
    deleteAgentFile: (id, name) =>
      mapped(
        Effect.gen(function* () {
          const persona = yield* personaOrFail(id);
          yield* attempt(() =>
            NodeFS.rmSync(NodePath.join(persona.dir, "files", safeName(name)), { force: true }),
          );
          return yield* agentResult(id);
        }),
      ),
    setToken: (value) =>
      mapped(
        Effect.gen(function* () {
          token = value.trim();
          yield* secrets.set(TOKEN_SECRET, new TextEncoder().encode(token));
          yield* Effect.forEach(personas(), (persona) => syncInstance(persona, { force: true }), {
            discard: true,
          });
          yield* emitDirectory;
        }),
      ),
    githubStatus: (id) =>
      mapped(
        Effect.gen(function* () {
          yield* prepareMember(yield* personaOrFail(id));
          return yield* Docker.githubStatus(id).pipe(Effect.provide(context));
        }),
      ),
    githubLogin: (id, scopes) =>
      mapped(
        Effect.gen(function* () {
          yield* prepareMember(yield* personaOrFail(id));
          return yield* Docker.githubLogin(id, scopes).pipe(Effect.provide(context));
        }),
      ),
    githubLogout: (id) =>
      mapped(
        Effect.gen(function* () {
          yield* personaOrFail(id);
          yield* Docker.githubLogout(id).pipe(Effect.provide(context));
        }),
      ),
    // The skills folder is the member's Claude home, so changes apply on its next turn.
    saveSkill: (id, skill) =>
      mapped(
        Effect.gen(function* () {
          const persona = yield* personaOrFail(id);
          yield* attempt(() => {
            validateSkillName(skill.name);
            const dir = NodePath.join(skillsDir(persona), skill.name);
            NodeFS.mkdirSync(dir, { recursive: true });
            NodeFS.writeFileSync(NodePath.join(dir, "SKILL.md"), serializeSkill(skill));
          });
          return yield* agentResult(id);
        }),
      ),
    deleteSkill: (id, name) =>
      mapped(
        Effect.gen(function* () {
          const persona = yield* personaOrFail(id);
          yield* attempt(() => {
            validateSkillName(name);
            NodeFS.rmSync(NodePath.join(skillsDir(persona), name), {
              recursive: true,
              force: true,
            });
          });
          return yield* agentResult(id);
        }),
      ),
    // The host's own Claude skills (`~/.claude/skills` or `CLAUDE_CONFIG_DIR`), as T3 discovers them.
    listHostSkills: discoverClaudeSkills({ homePath: "" }).pipe(
      Effect.map((skills) =>
        skills
          .filter((skill) => skill.scope === "user")
          .map((skill) => ({ name: skill.name, description: skill.description ?? "" })),
      ),
      Effect.provide(context),
    ),
    importSkill: (id, name) =>
      mapped(
        Effect.gen(function* () {
          const persona = yield* personaOrFail(id);
          const hostSkill = (yield* discoverClaudeSkills({ homePath: "" }).pipe(
            Effect.provide(context),
          )).find((skill) => skill.name === name && skill.scope === "user");
          if (!hostSkill) return yield* fail(`No existe la skill ${name} en tus skills de Claude.`);
          // Copies the whole folder: skills can ship scripts and references next to SKILL.md.
          yield* attempt(() => {
            validateSkillName(name);
            NodeFS.cpSync(
              NodePath.dirname(hostSkill.path),
              NodePath.join(skillsDir(persona), name),
              { recursive: true, dereference: true },
            );
          });
          return yield* agentResult(id);
        }),
      ),
  });
});

export const layer = Layer.effect(PuntosService, make);
