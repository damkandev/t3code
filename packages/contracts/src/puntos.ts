import * as Schema from "effect/Schema";

import { ChatAttachment } from "./chatAttachment.ts";

/**
 * Puntos: spaces (an "empresa" or project) whose members are Claude provider instances, each in
 * its own Docker container. A space holds group chats over a subset of its members, and each
 * member can also be talked to directly (DM) in a plain T3 thread. The server owns group logs;
 * clients fold `PuntosGroupEvent`s into `PuntosGroupState` and read live work from the threads.
 */

/** A host folder, mounted in the member's container at the same path. */
export const PuntosMount = Schema.Struct({
  host: Schema.String,
  rw: Schema.Boolean,
});
export type PuntosMount = typeof PuntosMount.Type;

/** Avatar shapes a member can pick; the color is the provider instance's accent color. */
export const PUNTOS_SHAPES = ["circle", "square", "triangle", "hexagon", "diamond"] as const;
export const PuntosShape = Schema.Literals(PUNTOS_SHAPES);
export type PuntosShape = typeof PuntosShape.Type;

/** A Claude Code skill: `skills/<name>/SKILL.md` in the member's Claude home. */
export const PuntosSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
});
export type PuntosSkill = typeof PuntosSkill.Type;
export const PuntosHostSkill = Schema.Struct({ name: Schema.String, description: Schema.String });

export const PuntosAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  shape: PuntosShape,
  model: Schema.String,
  mounts: Schema.Array(PuntosMount),
  prompt: Schema.String,
  files: Schema.Array(Schema.String),
  skills: Schema.Array(PuntosSkill),
  /** The member's Claude provider instance. */
  instanceId: Schema.String,
  /** The same member on the host's claude, for the user's own T3 code threads. */
  codeInstanceId: Schema.String,
  spaceIds: Schema.Array(Schema.String),
  accentColor: Schema.String,
});
export type PuntosAgent = typeof PuntosAgent.Type;

/** What the `html_render` tool returned during a member's turn (see `@t3tools/shared/htmlRender`). */
export const PuntosHtmlRender = Schema.Struct({
  attachmentId: Schema.String,
  title: Schema.String,
  height: Schema.Number,
  heights: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]))),
});

/** `author` is `"user"` or an agent id. A member's reply links to the thread and run it came from. */
export const PuntosMessage = Schema.Struct({
  id: Schema.String,
  ts: Schema.Number,
  author: Schema.String,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  renders: Schema.Array(PuntosHtmlRender),
  threadId: Schema.NullOr(Schema.String),
});
export type PuntosMessage = typeof PuntosMessage.Type;

/** `threads` maps a member id to its T3 thread for this group, where its full work log lives. */
export const PuntosGroup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  memberIds: Schema.Array(Schema.String),
  busy: Schema.Boolean,
  threads: Schema.Record(Schema.String, Schema.String),
});
export type PuntosGroup = typeof PuntosGroup.Type;

/** `folders` are the company folders every member gets; `dms` maps a member id to its DM thread. */
export const PuntosSpace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  memberIds: Schema.Array(Schema.String),
  folders: Schema.Array(PuntosMount),
  dms: Schema.Record(Schema.String, Schema.String),
  groups: Schema.Array(PuntosGroup),
});
export type PuntosSpace = typeof PuntosSpace.Type;

/** Everything but messages; the directory stream sends a fresh one on every change. */
export const PuntosDirectory = Schema.Struct({
  spaces: Schema.Array(PuntosSpace),
  agents: Schema.Array(PuntosAgent),
  hasToken: Schema.Boolean,
});
export type PuntosDirectory = typeof PuntosDirectory.Type;

export const PuntosGroupEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { messages: Schema.Array(PuntosMessage), busy: Schema.Boolean }),
  Schema.TaggedStruct("status", { busy: Schema.Boolean }),
  Schema.TaggedStruct("message", { message: PuntosMessage }),
  Schema.TaggedStruct("error", { agentId: Schema.String, error: Schema.String }),
]);
export type PuntosGroupEvent = typeof PuntosGroupEvent.Type;

export class PuntosError extends Schema.TaggedError<PuntosError>()("PuntosError", {
  message: Schema.String,
}) {}

export const PuntosGroupRef = Schema.Struct({ spaceId: Schema.String, groupId: Schema.String });
/** Attachments come from T3's signed upload flow (pending uploads), never inline bytes. */
export const PuntosSendMessageInput = Schema.Struct({
  spaceId: Schema.String,
  groupId: Schema.String,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
});
export const PuntosSaveAgentInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  shape: PuntosShape,
  model: Schema.String,
  mounts: Schema.Array(PuntosMount),
  prompt: Schema.String,
  spaceIds: Schema.Array(Schema.String),
});
/** Without `id` it creates a space. */
export const PuntosSaveSpaceInput = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  folders: Schema.Array(PuntosMount),
});
export const PuntosSpaceIdInput = Schema.Struct({ id: Schema.String });
/** Without `id` it creates a group. */
export const PuntosSaveGroupInput = Schema.Struct({
  spaceId: Schema.String,
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  memberIds: Schema.Array(Schema.String),
});
export const PuntosGroupIdInput = Schema.Struct({ spaceId: Schema.String, id: Schema.String });
export const PuntosOpenDirectInput = Schema.Struct({
  spaceId: Schema.String,
  agentId: Schema.String,
});
export const PuntosOpenDirectResult = Schema.Struct({ threadId: Schema.String });
export const PuntosAgentIdInput = Schema.Struct({ id: Schema.String });
export const PuntosSaveSkillInput = Schema.Struct({ id: Schema.String, skill: PuntosSkill });
export const PuntosSkillRefInput = Schema.Struct({ id: Schema.String, name: Schema.String });
export const PuntosAgentFilesInput = Schema.Struct({
  id: Schema.String,
  attachments: Schema.Array(ChatAttachment),
});
export const PuntosAgentFileDeleteInput = Schema.Struct({ id: Schema.String, name: Schema.String });
export const PuntosSetTokenInput = Schema.Struct({ token: Schema.String });

export const PUNTOS_GITHUB_SCOPES = [
  "workflow",
  "admin:org",
  "project",
  "write:packages",
  "delete_repo",
] as const;
export const PuntosGithubLoginInput = Schema.Struct({
  id: Schema.String,
  scopes: Schema.Array(Schema.Literals(PUNTOS_GITHUB_SCOPES)),
});
export const PuntosGithubLoginResult = Schema.Struct({ code: Schema.String, url: Schema.String });
export const PuntosGithubStatus = Schema.NullOr(
  Schema.Struct({
    login: Schema.String,
    scopes: Schema.Array(Schema.String),
    orgs: Schema.Array(Schema.String),
  }),
);
export type PuntosGithubStatus = typeof PuntosGithubStatus.Type;

export const PuntosOk = Schema.Struct({});

export interface PuntosGroupState {
  readonly loaded: boolean;
  readonly messages: ReadonlyArray<PuntosMessage>;
  readonly busy: boolean;
  readonly errors: ReadonlyArray<{ readonly agentId: string; readonly error: string }>;
}

export const EMPTY_PUNTOS_GROUP_STATE: PuntosGroupState = {
  loaded: false,
  messages: [],
  busy: false,
  errors: [],
};

export function reducePuntosGroupState(
  state: PuntosGroupState,
  event: PuntosGroupEvent,
): PuntosGroupState {
  switch (event._tag) {
    case "snapshot":
      return {
        ...EMPTY_PUNTOS_GROUP_STATE,
        loaded: true,
        messages: event.messages,
        busy: event.busy,
      };
    case "status":
      return {
        ...state,
        busy: event.busy,
        errors: event.busy && !state.busy ? [] : state.errors,
      };
    case "message":
      // A message can land in both the snapshot and the live stream right after subscribing.
      if (state.messages.some((m) => m.id === event.message.id)) return state;
      return { ...state, messages: [...state.messages, event.message] };
    case "error":
      return {
        ...state,
        errors: [...state.errors, { agentId: event.agentId, error: event.error }],
      };
  }
}
