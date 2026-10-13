import {
  type ChatAttachment,
  type ChatFileAttachment,
  type EnvironmentId,
  type PuntosAgent,
  type PuntosGroup,
  type PuntosGroupState,
  type PuntosMessage,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { Link, Navigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { detectComposerTrigger, replaceTextRange } from "../../composer-logic";
import { useTheme } from "../../hooks/useTheme";
import { type ComposerCommandItem, ComposerCommandMenu } from "../chat/ComposerCommandMenu";
import { useComposerTriggerState } from "../chat/useComposerTriggerState";
import { ComposerImageThumbnail } from "../chat/ComposerImageThumbnail";
import { ComposerPrimaryActions } from "../chat/ComposerPrimaryActions";
import { ComposerSurface } from "../chat/ComposerSurface";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";

import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { puntosEnvironment } from "../../state/puntos";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadShell } from "../../state/entities";
import { useAssetUrlState } from "../../assets/assetUrls";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { HtmlRenderFrame } from "../chat/HtmlRenderFrame";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PuntosAvatar } from "./PuntosAvatar";
import { PuntosGroupDialog } from "./PuntosGroupDialog";
import { PuntosMemberDialog } from "./PuntosMemberDialog";
import { PuntosSpaceDialog } from "./PuntosSpaceDialog";
import { type PendingUpload, releaseUploads, startUploads, finishUploads } from "./puntosUploads";

/** `/puntos`, `/puntos/$spaceId` and `/puntos/$spaceId/$groupId`; missing ids pick the first. */
export function PuntosPage({
  spaceId,
  groupId,
}: {
  readonly spaceId?: string;
  readonly groupId?: string;
}) {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {environmentId ? (
          <PuntosChat environmentId={environmentId} spaceId={spaceId} groupId={groupId} />
        ) : (
          <>
            <PuntosHeader title="Puntos" />
            <p className="p-6 text-sm text-muted-foreground">Conectando…</p>
          </>
        )}
      </div>
    </SidebarInset>
  );
}

function PuntosHeader({ title, action }: { readonly title: string; readonly action?: ReactNode }) {
  return (
    <WorkspacePageHeader electron={isElectron}>
      <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
      {action}
    </WorkspacePageHeader>
  );
}

/** Which dialog an empty state or the header opened. */
type PageDialog = "space" | "group" | "editGroup" | "member";

function PuntosChat({
  environmentId,
  spaceId,
  groupId,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: string | undefined;
  readonly groupId: string | undefined;
}) {
  const { data: directory, error } = useEnvironmentQuery(
    puntosEnvironment.directory({ environmentId, input: {} }),
  );
  const [dialog, setDialog] = useState<PageDialog | null>(null);
  const space = spaceId
    ? directory?.spaces.find((entry) => entry.id === spaceId)
    : directory?.spaces[0];
  const group = groupId ? space?.groups.find((entry) => entry.id === groupId) : undefined;
  const members = (directory?.agents ?? []).filter((agent) => space?.memberIds.includes(agent.id));

  // A bare `/puntos` or `/puntos/$spaceId` lands on the first group there is.
  const firstGroup = space?.groups[0];
  if (space && !groupId && firstGroup) {
    return (
      <Navigate
        to="/puntos/$spaceId/$groupId"
        params={{ spaceId: space.id, groupId: firstGroup.id }}
        replace
      />
    );
  }

  // A just-created space or group can be routed to before the directory catches up, so a missing
  // one shows a note instead of redirecting away.
  const empty = !directory ? null : directory.spaces.length === 0 ? (
    <PuntosEmpty
      title="Crea tu primer espacio"
      description="Un espacio por empresa o proyecto, con sus propios miembros y grupos."
      action="Nuevo espacio"
      onAction={() => setDialog("space")}
    />
  ) : !space ? (
    <PuntosEmpty title="Este espacio no existe" description="Elige otro desde la barra lateral." />
  ) : members.length === 0 ? (
    <PuntosEmpty
      title="Agrega el primer miembro"
      description={`Cada miembro de ${space.name} es un Claude con su propio computador.`}
      action="Nuevo miembro"
      onAction={() => setDialog("member")}
    />
  ) : !groupId ? (
    <PuntosEmpty
      title="Crea un grupo"
      description="Un chat con algunos miembros del espacio. También puedes escribirles por mensaje directo."
      action="Nuevo grupo"
      onAction={() => setDialog("group")}
    />
  ) : !group ? (
    <PuntosEmpty title="Este grupo no existe" description="Elige otro desde la barra lateral." />
  ) : null;

  return (
    <>
      <PuntosHeader
        title={[space?.name ?? "Puntos", group?.name].filter(Boolean).join(" · ")}
        action={
          group ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Editar grupo"
              onClick={() => setDialog("editGroup")}
            >
              <PencilIcon />
            </Button>
          ) : null
        }
      />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error ? <p className="p-4 text-sm text-destructive">{error}</p> : null}
        {directory && !directory.hasToken ? <TokenBanner environmentId={environmentId} /> : null}
        {space && group ? (
          <GroupChat
            key={`${space.id}/${group.id}`}
            environmentId={environmentId}
            spaceId={space.id}
            group={group}
            agents={members.filter((agent) => group.memberIds.includes(agent.id))}
          />
        ) : (
          (empty ?? <div className="flex-1" />)
        )}
      </section>
      {dialog === "space" ? (
        <PuntosSpaceDialog
          environmentId={environmentId}
          space={null}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {space && (dialog === "group" || dialog === "editGroup") ? (
        <PuntosGroupDialog
          environmentId={environmentId}
          spaceId={space.id}
          members={members}
          group={dialog === "editGroup" ? (group ?? null) : null}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {space && dialog === "member" ? (
        <PuntosMemberDialog
          environmentId={environmentId}
          spaceId={space.id}
          agent={null}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

function PuntosEmpty({
  title,
  description,
  action,
  onAction,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: string;
  readonly onAction?: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UsersIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && onAction ? (
        <EmptyContent>
          <Button onClick={onAction}>
            <PlusIcon />
            {action}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function GroupChat({
  environmentId,
  spaceId,
  group,
  agents,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  readonly group: PuntosGroup;
  readonly agents: ReadonlyArray<PuntosAgent>;
}) {
  const { data: state, error } = useEnvironmentQuery(
    puntosEnvironment.group({ environmentId, input: { spaceId, groupId: group.id } }),
  );
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return (
    <>
      {error ? <p className="p-4 text-sm text-destructive">{error}</p> : null}
      {state?.loaded ? (
        <Timeline
          environmentId={environmentId}
          state={state}
          group={group}
          agents={agents}
          byId={byId}
        />
      ) : (
        <div className="flex-1" />
      )}
      <Composer
        environmentId={environmentId}
        spaceId={spaceId}
        groupId={group.id}
        busy={state?.busy ?? false}
        agents={agents}
      />
    </>
  );
}

/** A file to preview: a group attachment, or an html_render page opened from its frame. */
type PreviewTarget = { readonly file: ChatAttachment; readonly htmlRender: boolean };

function Timeline({
  environmentId,
  state,
  group,
  agents,
  byId,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: PuntosGroupState;
  readonly group: PuntosGroup;
  readonly agents: ReadonlyArray<PuntosAgent>;
  readonly byId: ReadonlyMap<string, PuntosAgent>;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const { messages } = state;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, state.busy]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-(--chat-content-max-width) flex-col gap-4 p-4">
        {messages.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Escríbele al grupo. Usa @nombre para hablarle a alguien en particular.
          </p>
        ) : null}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            environmentId={environmentId}
            message={message}
            agent={byId.get(message.author)}
            onOpen={setPreview}
          />
        ))}
        {/* Who is working comes from each member's own thread, like the sidebar. */}
        {agents.map((agent) => {
          const threadId = group.threads[agent.id];
          return threadId ? (
            <WorkingRow
              key={agent.id}
              environmentId={environmentId}
              agent={agent}
              threadId={threadId}
            />
          ) : null;
        })}
        {state.errors.map((entry, index) => (
          <p key={index} className="text-sm text-destructive">
            {entry.agentId ? `${byId.get(entry.agentId)?.name ?? entry.agentId}: ` : ""}
            {entry.error}
          </p>
        ))}
        <div ref={bottomRef} />
      </div>
      {preview ? (
        <Dialog open onOpenChange={(open) => !open && setPreview(null)}>
          <DialogPopup
            className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">{preview.file.name}</DialogTitle>
            <AttachmentFilePreview
              name={preview.file.name}
              mimeType={preview.file.mimeType}
              sizeBytes={preview.file.sizeBytes}
              asset={{ environmentId, attachmentId: preview.file.id }}
              htmlRender={preview.htmlRender}
              origin="Puntos"
              onClose={() => setPreview(null)}
            />
          </DialogPopup>
        </Dialog>
      ) : null}
    </ScrollArea>
  );
}

function ThreadLink({
  environmentId,
  threadId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, ThreadId.make(threadId)))}
      className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
    >
      {children}
      <ArrowUpRightIcon className="size-3" />
    </Link>
  );
}

/** A member mid-turn: its thread's runtime is active. The full work log is one click away. */
function WorkingRow({
  environmentId,
  agent,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: PuntosAgent;
  readonly threadId: string;
}) {
  const ref = useMemo(
    () => scopeThreadRef(environmentId, ThreadId.make(threadId)),
    [environmentId, threadId],
  );
  const shell = useThreadShell(ref);
  if (!threadRuntimeIsActive(shell?.runtime)) return null;
  return (
    <AgentBubble agent={agent} fallbackName={agent.id}>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="animate-pulse">Trabajando…</span>
        <ThreadLink environmentId={environmentId} threadId={threadId}>
          Ver en vivo
        </ThreadLink>
      </p>
    </AgentBubble>
  );
}

function MessageRow({
  environmentId,
  message,
  agent,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly message: PuntosMessage;
  readonly agent: PuntosAgent | undefined;
  readonly onOpen: (target: PreviewTarget) => void;
}) {
  const files = message.attachments.length ? (
    <div className="flex flex-wrap gap-2">
      {message.attachments.map((attachment) => (
        <GroupAttachment
          key={attachment.id}
          environmentId={environmentId}
          attachment={attachment}
          onOpen={() => onOpen({ file: attachment, htmlRender: false })}
        />
      ))}
    </div>
  ) : null;
  if (message.author === "user") {
    return (
      <div className="flex flex-col items-end gap-2">
        {files}
        {message.text ? (
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-message px-3 py-2 text-sm text-message-foreground">
            {message.text}
          </div>
        ) : null}
      </div>
    );
  }
  const threadRef = message.threadId
    ? scopeThreadRef(environmentId, ThreadId.make(message.threadId))
    : undefined;
  return (
    <AgentBubble
      agent={agent}
      fallbackName={message.author}
      action={
        message.threadId ? (
          <ThreadLink environmentId={environmentId} threadId={message.threadId}>
            Ver trabajo
          </ThreadLink>
        ) : null
      }
    >
      {message.text ? (
        <ChatMarkdown text={message.text} cwd={undefined} environmentId={environmentId} />
      ) : null}
      {message.renders.map((render) => (
        <HtmlRenderFrame
          key={render.attachmentId}
          environmentId={environmentId}
          htmlRender={render}
          threadRef={threadRef}
          onOpen={(file: ChatFileAttachment) => onOpen({ file, htmlRender: true })}
        />
      ))}
      {files}
    </AgentBubble>
  );
}

function AgentBubble({
  agent,
  fallbackName,
  action,
  children,
}: {
  readonly agent: PuntosAgent | undefined;
  readonly fallbackName: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <PuntosAvatar
        shape={agent?.shape ?? "circle"}
        color={agent?.accentColor}
        className="mt-0.5 size-7"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {agent?.name ?? fallbackName}
          {action}
        </p>
        {children}
      </div>
    </div>
  );
}

/** A group attachment served through T3's asset URLs; images show inline, the rest as a row. */
function GroupAttachment({
  environmentId,
  attachment,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
  readonly onOpen: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const resource = useMemo(
    () =>
      attachment.type === "image"
        ? {
            _tag: "attachment" as const,
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
            disposition: "inline" as const,
          }
        : null,
    [attachment],
  );
  const image = useAssetUrlState(environmentId, resource);
  if (attachment.type === "image" && image._tag === "Success") {
    return (
      <button
        type="button"
        className="cursor-zoom-in"
        aria-label={attachment.name}
        onClick={onOpen}
      >
        <img
          src={image.url}
          alt={attachment.name}
          className="max-h-64 max-w-full rounded-lg border object-contain"
        />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 max-w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-sm hover:bg-accent"
    >
      <PierreEntryIcon pathValue={attachment.name} kind="file" theme={resolvedTheme} />
      <span className="min-w-0 truncate">{attachment.name}</span>
    </button>
  );
}

function TokenBanner({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [token, setToken] = useState("");
  const saveToken = useAtomCommand(puntosEnvironment.setToken);
  return (
    <form
      className="flex items-center gap-2 border-b p-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim()) void saveToken({ environmentId, input: { token } });
      }}
    >
      <span className="shrink-0 text-muted-foreground">
        Corre <code>claude setup-token</code> y pega el token:
      </span>
      <Input
        type="password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="sk-ant-oat01-…"
      />
      <Button type="submit" size="sm" disabled={!token.trim()}>
        Guardar
      </Button>
    </form>
  );
}

const NO_SKILLS: ReadonlyArray<never> = [];
const noop = () => {};

/** The T3 chat composer pieces (glass surface, prompt editor, thumbnails, send) for the group. */
function Composer({
  environmentId,
  spaceId,
  groupId,
  busy,
  agents,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly busy: boolean;
  readonly agents: ReadonlyArray<PuntosAgent>;
}) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<ReadonlyArray<PendingUpload>>([]);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const sendMessage = useAtomCommand(puntosEnvironment.sendMessage);
  const canSend = useAtomValue(puntosEnvironment.sendMessage.permissionAtom(environmentId));
  const disabled = busy || sending || !canSend || agents.length === 0;
  const hasContent = text.trim().length > 0 || files.length > 0;
  const setPrompt = (value: string, nextCursor: number) => {
    setText(value);
    setCursor(nextCursor);
  };
  const mention = useMemberMention(agents, text, setPrompt);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const addFiles = (added: ReadonlyArray<File>) =>
    setFiles((current) => [...current, ...startUploads(environmentId, added)]);

  const send = async () => {
    if (disabled || !hasContent) return;
    setSending(true);
    setUploadError(null);
    const attachments = await finishUploads(environmentId, files);
    if (attachments === null) {
      setSending(false);
      setUploadError("Algún archivo no se pudo subir; quítalo e inténtalo de nuevo.");
      return;
    }
    const result = await sendMessage({
      environmentId,
      input: { spaceId, groupId, text, attachments },
    });
    setSending(false);
    if (result._tag === "Success") {
      setPrompt("", 0);
      setFiles([]);
      editorRef.current?.focus();
    }
  };

  return (
    <div className="px-3 pb-3 sm:px-5 sm:pb-4">
      <div className="relative">
        {mention.menu}
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <div className="relative z-10">
              <form
                className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
                data-chat-composer-form="true"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <ComposerSurface.Main>
                  <div data-chat-composer-surface="true" className="rounded-3xl">
                    <div className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
                      {files.length ? (
                        <div className="mb-3 flex max-w-full flex-wrap gap-2">
                          {files.map((upload) => (
                            <div
                              key={upload.id}
                              className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background"
                            >
                              {upload.file ? (
                                <ComposerImageThumbnail
                                  file={upload.file}
                                  alt={upload.name}
                                  className="h-full w-full object-cover"
                                  fallback={
                                    <span className="flex h-full items-center justify-center break-all px-1 text-3xs text-secondary-label">
                                      {upload.name}
                                    </span>
                                  }
                                />
                              ) : null}
                              <span className="absolute right-1 top-1 flex">
                                <Button
                                  type="button"
                                  variant="media-close"
                                  size="icon-xs"
                                  aria-label={`Quitar ${upload.name}`}
                                  onClick={() => {
                                    releaseUploads([upload]);
                                    setFiles((current) =>
                                      current.filter((entry) => entry.id !== upload.id),
                                    );
                                  }}
                                >
                                  <XIcon />
                                </Button>
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <ComposerPromptEditor
                        ariaLabel="Mensaje"
                        editorRef={editorRef}
                        value={text}
                        cursor={cursor}
                        contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
                        skills={NO_SKILLS}
                        disabled={!canSend}
                        placeholder={
                          agents.length
                            ? `Escribe a ${agents.map((agent) => agent.name).join(", ")}… (@nombre para uno)`
                            : "Agrega un miembro para empezar"
                        }
                        onChange={(value, nextCursor) => {
                          setPrompt(value, nextCursor);
                          mention.track(value, nextCursor);
                        }}
                        onCommandKeyDown={(key, event, inList) => {
                          if (mention.handleKey(key)) return true;
                          if (key !== "Enter" || event.shiftKey || event.altKey || inList) {
                            return false;
                          }
                          void send();
                          return true;
                        }}
                        onPaste={(event) => {
                          const pasted = Array.from(event.clipboardData.files);
                          if (!pasted.length) return;
                          event.preventDefault();
                          event.stopPropagation();
                          addFiles(pasted);
                        }}
                      />
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {busy ? (
                          <span className="text-xs text-muted-foreground">Respondiendo…</span>
                        ) : null}
                        {uploadError ? (
                          <span className="text-xs text-destructive">{uploadError}</span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center justify-end gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          hidden
                          onChange={(event) => {
                            addFiles(Array.from(event.target.files ?? []));
                            event.target.value = "";
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Adjuntar archivos"
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <PaperclipIcon />
                        </Button>
                        <ComposerPrimaryActions
                          compact={false}
                          canOperateThread={canSend}
                          pendingAction={null}
                          isRunning={false}
                          canInterrupt={false}
                          showPlanFollowUpPrompt={false}
                          promptHasText={text.trim().length > 0}
                          isSendBusy={sending}
                          sendDisabledReason={
                            busy
                              ? "Hay una ronda en curso."
                              : agents.length === 0
                                ? "Agrega un miembro primero."
                                : null
                          }
                          isConnecting={false}
                          isEnvironmentUnavailable={false}
                          isPreparingWorktree={false}
                          hasSendableContent={hasContent && !disabled}
                          onPreviousPendingQuestion={noop}
                          onInterrupt={noop}
                          onImplementPlanInNewThread={noop}
                        />
                      </div>
                    </div>
                  </div>
                </ComposerSurface.Main>
              </form>
            </div>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </div>
  );
}

/** `@` autocomplete for members, using the chat composer's suggestion menu. */
function useMemberMention(
  agents: ReadonlyArray<PuntosAgent>,
  text: string,
  setPrompt: (text: string, cursor: number) => void,
) {
  const { resolvedTheme } = useTheme();
  const listId = useId();
  const { trigger, setTrigger, dismissTrigger } = useComposerTriggerState(() => null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const query = trigger?.kind === "path" ? trigger.query.toLowerCase() : null;
  const items: ComposerCommandItem[] =
    query === null
      ? []
      : agents
          .filter((agent) =>
            [agent.name, agent.id].some((key) => key.toLowerCase().includes(query)),
          )
          .map((agent) => ({
            id: agent.id,
            type: "member",
            icon: <PuntosAvatar shape={agent.shape} color={agent.accentColor} />,
            label: agent.name,
            description: `@${agent.id}`,
          }));
  const active = items.find((item) => item.id === activeId) ?? items[0] ?? null;

  const select = (item: ComposerCommandItem) => {
    const agent = agents.find((entry) => entry.id === item.id);
    if (!trigger || !agent) return;
    // The server matches `@name` or `@id`; names with spaces fall back to the id.
    const handle = /^\S+$/.test(agent.name) ? agent.name : agent.id;
    const next = replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, `@${handle} `);
    setTrigger(null);
    setPrompt(next.text, next.cursor);
  };

  return {
    track: (value: string, cursor: number) => setTrigger(detectComposerTrigger(value, cursor)),
    /** Returns true when the key was consumed by the open menu. */
    handleKey: (key: string) => {
      if (!trigger || items.length === 0) return false;
      const index = active ? items.indexOf(active) : 0;
      if (key === "ArrowDown" || key === "ArrowUp") {
        const step = key === "ArrowDown" ? 1 : -1;
        setActiveId(items[(index + step + items.length) % items.length]?.id ?? null);
      } else if ((key === "Enter" || key === "Tab") && active) {
        select(active);
      } else if (key === "Escape") {
        dismissTrigger(trigger);
      } else {
        return false;
      }
      return true;
    },
    menu:
      items.length > 0 ? (
        <div className="absolute inset-x-0 bottom-full z-20 mx-auto max-w-(--chat-content-max-width) px-4">
          <ComposerCommandMenu
            listId={listId}
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={false}
            triggerKind="path"
            activeItemId={active?.id ?? null}
            onHighlightedItemChange={setActiveId}
            onSelect={select}
          />
        </div>
      ) : null,
  };
}
