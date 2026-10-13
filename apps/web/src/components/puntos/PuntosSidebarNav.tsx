import {
  type EnvironmentId,
  type PuntosAgent,
  type PuntosGroup,
  type PuntosSpace,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  BuildingIcon,
  ChevronsUpDownIcon,
  CircleDashedIcon,
  PencilIcon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { puntosEnvironment } from "../../state/puntos";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { PuntosAvatar } from "./PuntosAvatar";
import { PuntosGroupDialog } from "./PuntosGroupDialog";
import { PuntosMemberDialog } from "./PuntosMemberDialog";
import { PuntosSpaceDialog } from "./PuntosSpaceDialog";

// The thread sidebar's row surface (`rowSurfaceClassName` in Sidebar.tsx).
const ROW_CLASS_NAME =
  "group/sidebar-row relative flex h-9 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md bg-transparent px-2.5 text-left text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const ACTIVE_ROW_CLASS_NAME = "bg-sidebar-row-active";

/** Which dialog is open. A member is looked up live by id (`null` = new). */
type Editing =
  | { readonly kind: "space"; readonly space: PuntosSpace | null }
  | { readonly kind: "group"; readonly group: PuntosGroup | null }
  | { readonly kind: "member"; readonly id: string | null };

/** Sidebar body on `/puntos/*`: the space switcher, its groups, DMs and members. */
export function PuntosSidebarNav() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        {environmentId ? <PuntosDirectoryNav environmentId={environmentId} /> : null}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function PuntosDirectoryNav({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { data: directory } = useEnvironmentQuery(
    puntosEnvironment.directory({ environmentId, input: {} }),
  );
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openDirect = useAtomCommand(puntosEnvironment.openDirect);
  const saveAgent = useAtomCommand(puntosEnvironment.saveAgent);
  const [editing, setEditing] = useState<Editing | null>(null);
  const spaces = directory?.spaces ?? [];
  // `/puntos` itself redirects to the first space, so it is the current one there too.
  const space = spaces.find((entry) => entry.id === params.spaceId) ?? spaces[0];
  const agents = directory?.agents ?? [];
  const members = agents.filter((agent) => space?.memberIds.includes(agent.id));
  // Members from other spaces can join this one too; they keep their memory and computer.
  const others = agents.filter((agent) => space && !space.memberIds.includes(agent.id));
  const addExisting = (agent: PuntosAgent, spaceId: string) =>
    void saveAgent({
      environmentId,
      input: {
        id: agent.id,
        name: agent.name,
        shape: agent.shape,
        model: agent.model,
        mounts: agent.mounts,
        prompt: agent.prompt,
        spaceIds: [...agent.spaceIds, spaceId],
      },
    });
  const editingMember =
    editing?.kind === "member" && editing.id !== null
      ? members.find((agent) => agent.id === editing.id)
      : undefined;
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  const openDm = async (targetSpace: PuntosSpace, agentId: string) => {
    const result = await openDirect({
      environmentId,
      input: { spaceId: targetSpace.id, agentId },
    });
    if (result._tag !== "Success") return;
    closeMobile();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(environmentId, ThreadId.make(result.value.threadId)),
      ),
    });
  };

  return (
    <>
      <SidebarGroup>
        <Menu>
          <MenuTrigger render={<button type="button" className={ROW_CLASS_NAME} />}>
            <BuildingIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {space?.name ?? "Sin espacios"}
            </span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
          </MenuTrigger>
          <MenuPopup align="start">
            {spaces.length ? (
              <>
                <MenuRadioGroup
                  value={space?.id ?? ""}
                  onValueChange={(spaceId: string) => {
                    closeMobile();
                    void navigate({ to: "/puntos/$spaceId", params: { spaceId } });
                  }}
                >
                  {spaces.map((entry) => (
                    <MenuRadioItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuSeparator />
              </>
            ) : null}
            {space ? (
              <MenuItem onClick={() => setEditing({ kind: "space", space })}>
                <PencilIcon />
                Editar espacio
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => setEditing({ kind: "space", space: null })}>
              <PlusIcon />
              Nuevo espacio
            </MenuItem>
          </MenuPopup>
        </Menu>
      </SidebarGroup>

      {space ? (
        <>
          <SidebarGroup>
            <SectionHeader
              label="Grupos"
              addLabel="Nuevo grupo"
              onAdd={() => setEditing({ kind: "group", group: null })}
            />
            <ul className="flex flex-col gap-px">
              {space.groups.map((group) => (
                <li key={group.id}>
                  <Link
                    to="/puntos/$spaceId/$groupId"
                    params={{ spaceId: space.id, groupId: group.id }}
                    className={ROW_CLASS_NAME}
                    activeProps={{ className: ACTIVE_ROW_CLASS_NAME }}
                    onClick={closeMobile}
                  >
                    <UsersIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{group.name}</span>
                    {group.busy ? <WorkingBadge /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </SidebarGroup>

          <SidebarGroup>
            <SectionHeader label="Mensajes directos" />
            <ul className="flex flex-col gap-px">
              {members.map((agent) => {
                const threadId = space.dms[agent.id];
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      className={ROW_CLASS_NAME}
                      onClick={() => void openDm(space, agent.id)}
                    >
                      <PuntosAvatar shape={agent.shape} color={agent.accentColor} />
                      <span className="min-w-0 flex-1 truncate text-sm">{agent.name}</span>
                      {threadId ? (
                        <MemberWorking environmentId={environmentId} threadId={threadId} />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </SidebarGroup>

          <SidebarGroup>
            <div className="flex h-7 items-center justify-between gap-2 pr-1 pl-2">
              <p className="text-2xs font-medium text-sidebar-muted-foreground">Miembros</p>
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="icon-micro" variant="ghost-muted" aria-label="Agregar miembro" />
                  }
                >
                  <PlusIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => setEditing({ kind: "member", id: null })}>
                    <PlusIcon />
                    Nuevo miembro
                  </MenuItem>
                  {others.length ? (
                    <>
                      <MenuSeparator />
                      <MenuGroup>
                        <MenuGroupLabel>De otros espacios</MenuGroupLabel>
                        {others.map((agent) => (
                          <MenuItem key={agent.id} onClick={() => addExisting(agent, space.id)}>
                            <PuntosAvatar shape={agent.shape} color={agent.accentColor} />
                            {agent.name}
                          </MenuItem>
                        ))}
                      </MenuGroup>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
            <ul className="flex flex-col gap-px">
              {members.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className={cn(
                      ROW_CLASS_NAME,
                      editingMember?.id === agent.id && ACTIVE_ROW_CLASS_NAME,
                    )}
                    onClick={() => setEditing({ kind: "member", id: agent.id })}
                  >
                    <PuntosAvatar shape={agent.shape} color={agent.accentColor} />
                    <span className="min-w-0 flex-1 truncate text-sm">{agent.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </SidebarGroup>
        </>
      ) : null}

      {editing?.kind === "space" ? (
        <PuntosSpaceDialog
          environmentId={environmentId}
          space={editing.space}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {space && editing?.kind === "group" ? (
        <PuntosGroupDialog
          environmentId={environmentId}
          spaceId={space.id}
          members={members}
          group={editing.group}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {space && editing?.kind === "member" && (editing.id === null || editingMember) ? (
        <PuntosMemberDialog
          environmentId={environmentId}
          spaceId={space.id}
          agent={editingMember ?? null}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function SectionHeader({
  label,
  addLabel,
  onAdd,
}: {
  readonly label: string;
  readonly addLabel?: string;
  readonly onAdd?: () => void;
}) {
  return (
    <div className="flex h-7 items-center justify-between gap-2 pr-1 pl-2">
      <p className="text-2xs font-medium text-sidebar-muted-foreground">{label}</p>
      {onAdd ? (
        <Button size="icon-micro" variant="ghost-muted" aria-label={addLabel} onClick={onAdd}>
          <PlusIcon />
        </Button>
      ) : null}
    </div>
  );
}

function WorkingBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-info">
      <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
      <span role="status">Trabajando</span>
    </span>
  );
}

/** Same signal the thread list uses: the member's thread has an active runtime. */
function MemberWorking({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) {
  const ref = useMemo(
    () => scopeThreadRef(environmentId, ThreadId.make(threadId)),
    [environmentId, threadId],
  );
  const shell = useThreadShell(ref);
  return threadRuntimeIsActive(shell?.runtime) ? <WorkingBadge /> : null;
}
