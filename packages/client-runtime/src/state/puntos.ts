import { EMPTY_PUNTOS_GROUP_STATE, reducePuntosGroupState, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPuntosEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = <TTag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(
    name: string,
    tag: TTag,
  ) => createEnvironmentRpcCommand(runtime, { label: `environment-data:puntos:${name}`, tag });
  return {
    /** Spaces, their groups, members and token status; the latest snapshot. */
    directory: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:puntos:directory",
      tag: WS_METHODS.puntosSubscribeDirectory,
    }),
    /** One group's events folded into its chat state. Input: `{ spaceId, groupId }`. */
    group: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:puntos:group",
      tag: WS_METHODS.puntosSubscribeGroup,
      transform: (stream) =>
        stream.pipe(Stream.scan(() => EMPTY_PUNTOS_GROUP_STATE, reducePuntosGroupState)),
    }),
    githubStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:puntos:github-status",
      tag: WS_METHODS.puntosGithubStatus,
    }),
    sendMessage: command("send-message", WS_METHODS.puntosSendMessage),
    saveSpace: command("save-space", WS_METHODS.puntosSaveSpace),
    deleteSpace: command("delete-space", WS_METHODS.puntosDeleteSpace),
    saveGroup: command("save-group", WS_METHODS.puntosSaveGroup),
    deleteGroup: command("delete-group", WS_METHODS.puntosDeleteGroup),
    openDirect: command("open-direct", WS_METHODS.puntosOpenDirect),
    saveAgent: command("save-agent", WS_METHODS.puntosSaveAgent),
    deleteAgent: command("delete-agent", WS_METHODS.puntosDeleteAgent),
    resetAgent: command("reset-agent", WS_METHODS.puntosResetAgent),
    addAgentFiles: command("add-agent-files", WS_METHODS.puntosAddAgentFiles),
    deleteAgentFile: command("delete-agent-file", WS_METHODS.puntosDeleteAgentFile),
    setToken: command("set-token", WS_METHODS.puntosSetToken),
    githubLogin: command("github-login", WS_METHODS.puntosGithubLogin),
    githubLogout: command("github-logout", WS_METHODS.puntosGithubLogout),
    saveSkill: command("save-skill", WS_METHODS.puntosSaveSkill),
    deleteSkill: command("delete-skill", WS_METHODS.puntosDeleteSkill),
    importSkill: command("import-skill", WS_METHODS.puntosImportSkill),
    hostSkills: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:puntos:host-skills",
      tag: WS_METHODS.puntosListHostSkills,
    }),
  };
}
