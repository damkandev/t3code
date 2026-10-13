import {
  PUNTOS_GITHUB_SCOPES,
  PUNTOS_SHAPES,
  type EnvironmentId,
  type PuntosAgent,
  type PuntosMount,
  type PuntosSkill,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";

import { puntosEnvironment } from "../../state/puntos";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PuntosAvatar } from "./PuntosAvatar";
import { PuntosFolderList } from "./PuntosFolderPicker";
import { finishUploads, releaseUploads, startUploads } from "./puntosUploads";

const SHAPE_LABELS = {
  circle: "Círculo",
  square: "Cuadrado",
  triangle: "Triángulo",
  hexagon: "Hexágono",
  diamond: "Rombo",
} as const;

/** Create (`agent === null`) or edit a Puntos member. */
export function PuntosMemberDialog({
  environmentId,
  spaceId,
  agent,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  /** The space a new member joins; an existing one keeps its spaces. */
  readonly spaceId: string;
  readonly agent: PuntosAgent | null;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState({
    id: agent?.id ?? "",
    name: agent?.name ?? "",
    shape: agent?.shape ?? "circle",
    model: agent?.model || "sonnet",
    prompt: agent?.prompt ?? "",
    mounts: agent?.mounts ?? ([] as ReadonlyArray<PuntosMount>),
    spaceIds: agent?.spaceIds ?? ([spaceId] as ReadonlyArray<string>),
  });
  const [pending, setPending] = useState(false);
  const saveAgent = useAtomCommand(puntosEnvironment.saveAgent);
  const deleteAgent = useAtomCommand(puntosEnvironment.deleteAgent);
  const resetAgent = useAtomCommand(puntosEnvironment.resetAgent);

  const run = async (action: () => Promise<{ readonly _tag: string }>) => {
    setPending(true);
    const result = await action();
    setPending(false);
    if (result._tag === "Success") onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <PuntosAvatar shape={draft.shape} color={agent?.accentColor} className="size-5" />
            <DialogTitle>{agent ? agent.name : "Nuevo miembro"}</DialogTitle>
          </div>
          <DialogDescription>
            Cada miembro es una instancia de Claude que corre en su propio contenedor Docker, sin
            pedir permisos, con su propio hilo en T3.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[1fr_8rem] gap-3">
              <Field label="Nombre">
                <Input
                  value={draft.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setDraft({
                      ...draft,
                      name,
                      // Derive the id from the name until the member exists.
                      id: agent ? draft.id : name.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
                    });
                  }}
                />
              </Field>
              <Field label="Modelo">
                <MemberModelPicker
                  environmentId={environmentId}
                  instanceId={agent?.instanceId ?? null}
                  model={draft.model}
                  onChange={(model) => setDraft({ ...draft, model })}
                />
              </Field>
            </div>
            <Field label="Forma">
              <ToggleGroup
                aria-label="Forma del avatar"
                variant="outline"
                value={[draft.shape]}
                onValueChange={(next) => {
                  const shape = PUNTOS_SHAPES.find((entry) => entry === next[0]);
                  if (shape) setDraft({ ...draft, shape });
                }}
              >
                {PUNTOS_SHAPES.map((shape) => (
                  <Toggle key={shape} value={shape} aria-label={SHAPE_LABELS[shape]}>
                    <PuntosAvatar shape={shape} color={agent?.accentColor} />
                  </Toggle>
                ))}
              </ToggleGroup>
            </Field>
            {agent ? null : (
              <Field label="Id (a-z, 0-9, -)">
                <Input
                  value={draft.id}
                  onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                />
              </Field>
            )}
            <Field label="Personalidad (prompt)">
              <Textarea
                rows={6}
                value={draft.prompt}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                placeholder="Eres Vale, una diseñadora…"
              />
            </Field>
            <MemberSpaces
              environmentId={environmentId}
              value={draft.spaceIds}
              onChange={(spaceIds) => setDraft({ ...draft, spaceIds })}
            />
            <Section title="Carpetas de tu PC" description="Las ve en la misma ruta que en tu PC.">
              <PuntosFolderList
                environmentId={environmentId}
                value={draft.mounts}
                onChange={(mounts) => setDraft({ ...draft, mounts })}
              />
            </Section>
            {agent ? (
              <Section
                title="Conocimiento"
                description="Archivos de referencia y skills de Claude Code."
              >
                <AgentFiles environmentId={environmentId} agent={agent} />
                <AgentSkills environmentId={environmentId} agent={agent} />
              </Section>
            ) : null}
            <AgentGithub environmentId={environmentId} agent={agent} name={draft.name} />
          </div>
        </DialogPanel>
        <DialogFooter>
          {agent ? (
            <>
              <Button
                variant="destructive-outline"
                disabled={pending}
                onClick={() =>
                  confirm(`¿Eliminar a ${agent.name}? Se borra su computadora y su historial.`) &&
                  void run(() => deleteAgent({ environmentId, input: { id: agent.id } }))
                }
              >
                Eliminar
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  confirm(
                    `¿Resetear la computadora de ${agent.name}? Pierde su home y su sesión.`,
                  ) && void run(() => resetAgent({ environmentId, input: { id: agent.id } }))
                }
              >
                Resetear PC
              </Button>
            </>
          ) : null}
          <Button
            disabled={pending || !draft.name.trim() || !draft.id || draft.spaceIds.length === 0}
            onClick={() => void run(() => saveAgent({ environmentId, input: draft }))}
          >
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * T3's model picker over the member's own Claude instance. A member being created has no instance
 * yet, so it borrows another Claude instance's catalog; the model applies to the new instance.
 */
function MemberModelPicker({
  environmentId,
  instanceId,
  model,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string | null;
  readonly model: string;
  readonly onChange: (model: string) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(() => {
    const claude = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
    ).filter((entry) => entry.driverKind === "claudeAgent");
    const own = claude.filter((entry) => entry.instanceId === instanceId);
    return own.length ? own : claude.slice(0, 1);
  }, [providers, settings, instanceId]);
  const active = entries[0];
  const modelOptionsByInstance = useMemo(
    () =>
      active
        ? getCustomModelOptionsByInstance(settings, providers, active.instanceId, model)
        : undefined,
    [settings, providers, active, model],
  );
  if (!active || !modelOptionsByInstance) {
    return <Input value={model} onChange={(event) => onChange(event.target.value)} />;
  }
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      activeInstanceId={active.instanceId}
      model={model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptionsByInstance}
      isComposerOwned={false}
      onInstanceModelChange={(_instanceId, next) => onChange(next)}
    />
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

const EMPTY_SKILL: PuntosSkill = { name: "", description: "", instructions: "" };

/** Claude Code skills for this member: written, edited, or imported from the host's ~/.claude/skills. */
function AgentSkills({
  environmentId,
  agent,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: PuntosAgent;
}) {
  // `null` = closed; `isNew` decides whether the name can still change.
  const [draft, setDraft] = useState<{ skill: PuntosSkill; isNew: boolean } | null>(null);
  const saveSkill = useAtomCommand(puntosEnvironment.saveSkill);
  const deleteSkill = useAtomCommand(puntosEnvironment.deleteSkill);
  const importSkill = useAtomCommand(puntosEnvironment.importSkill);
  const hostSkills = useEnvironmentQuery(
    puntosEnvironment.hostSkills({ environmentId, input: {} }),
  );
  const importable = (hostSkills.data ?? []).filter(
    (skill) => !agent.skills.some((own) => own.name === skill.name),
  );

  return (
    <div className="flex flex-col gap-2">
      <Label>Skills</Label>
      {agent.skills.map((skill) => (
        <div key={skill.name} className="flex items-center gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{skill.name}</p>
            {skill.description ? (
              <p className="truncate text-xs text-muted-foreground">{skill.description}</p>
            ) : null}
          </div>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Editar ${skill.name}`}
            onClick={() => setDraft({ skill, isNew: false })}
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={`Borrar ${skill.name}`}
            onClick={() =>
              void deleteSkill({ environmentId, input: { id: agent.id, name: skill.name } })
            }
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      {draft ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <Input
            value={draft.skill.name}
            disabled={!draft.isNew}
            placeholder="nombre-de-la-skill"
            onChange={(event) =>
              setDraft({
                ...draft,
                skill: {
                  ...draft.skill,
                  name: event.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
                },
              })
            }
          />
          <Input
            value={draft.skill.description}
            placeholder="Cuándo usarla (Claude decide con esto si la carga)"
            onChange={(event) =>
              setDraft({ ...draft, skill: { ...draft.skill, description: event.target.value } })
            }
          />
          <Textarea
            rows={6}
            value={draft.skill.instructions}
            placeholder="Instrucciones en markdown…"
            onChange={(event) =>
              setDraft({ ...draft, skill: { ...draft.skill, instructions: event.target.value } })
            }
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              disabled={!draft.skill.name || !draft.skill.description.trim()}
              onClick={async () => {
                const result = await saveSkill({
                  environmentId,
                  input: { id: agent.id, skill: draft.skill },
                });
                if (result._tag === "Success") setDraft(null);
              }}
            >
              Guardar skill
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() => setDraft({ skill: EMPTY_SKILL, isNew: true })}
          >
            <PlusIcon />
            Nueva skill
          </Button>
          {importable.length ? (
            <Select
              value={null}
              onValueChange={(name) =>
                name && void importSkill({ environmentId, input: { id: agent.id, name } })
              }
            >
              <SelectTrigger size="sm" className="w-auto">
                <SelectValue placeholder="Importar de tus skills de Claude" />
              </SelectTrigger>
              <SelectPopup>
                {importable.map((skill) => (
                  <SelectItem key={skill.name} value={skill.name}>
                    {skill.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AgentFiles({
  environmentId,
  agent,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: PuntosAgent;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addFiles = useAtomCommand(puntosEnvironment.addAgentFiles);
  const remove = useAtomCommand(puntosEnvironment.deleteAgentFile);
  return (
    <div className="flex flex-col gap-2">
      <Label>Archivos del miembro (/knowledge)</Label>
      {agent.files.map((name) => (
        <div key={name} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={`Borrar ${name}`}
            onClick={() => void remove({ environmentId, input: { id: agent.id, name } })}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={async (event) => {
          const uploads = startUploads(environmentId, Array.from(event.target.files ?? []));
          event.target.value = "";
          const attachments = await finishUploads(environmentId, uploads);
          if (attachments === null) {
            releaseUploads(uploads);
            return;
          }
          await addFiles({ environmentId, input: { id: agent.id, attachments } });
        }}
      />
      <Button
        size="sm"
        variant="ghost-muted"
        className="self-start"
        onClick={() => inputRef.current?.click()}
      >
        <PlusIcon />
        Subir archivos
      </Button>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t pt-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** The spaces a member belongs to; at least one. Hidden while there is only one space. */
function MemberSpaces({
  environmentId,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ReadonlyArray<string>;
  readonly onChange: (next: ReadonlyArray<string>) => void;
}) {
  const directory = useEnvironmentQuery(puntosEnvironment.directory({ environmentId, input: {} }));
  const spaces = directory.data?.spaces ?? [];
  if (spaces.length < 2) return null;
  return (
    <Section title="Espacios" description="Puede trabajar en varios espacios a la vez.">
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {spaces.map((space) => {
          const checked = value.includes(space.id);
          return (
            <label key={space.id} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={checked}
                // The last space can't be unchecked: a member always belongs somewhere.
                disabled={checked && value.length === 1}
                onCheckedChange={(next) =>
                  onChange(
                    next === true ? [...value, space.id] : value.filter((id) => id !== space.id),
                  )
                }
              />
              {space.name}
            </label>
          );
        })}
      </div>
    </Section>
  );
}

/** gh device-flow login inside the member's container; its commits and PRs use this account. */
function AgentGithub({
  environmentId,
  agent,
  name,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: PuntosAgent | null;
  readonly name: string;
}) {
  return (
    <Section
      title="Cuenta de GitHub"
      description={`Cuenta de GitHub de ${name.trim() || "este miembro"}: sus commits y PRs salen con esta cuenta.`}
    >
      {agent ? (
        <AgentGithubLogin environmentId={environmentId} agentId={agent.id} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Guarda el miembro para conectar su cuenta de GitHub.
        </p>
      )}
    </Section>
  );
}

function AgentGithubLogin({
  environmentId,
  agentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly agentId: string;
}) {
  const status = useEnvironmentQuery(
    puntosEnvironment.githubStatus({ environmentId, input: { id: agentId } }),
  );
  const login = useAtomCommand(puntosEnvironment.githubLogin);
  const logout = useAtomCommand(puntosEnvironment.githubLogout);
  const [device, setDevice] = useState<{ code: string; url: string } | null>(null);
  const [scopes, setScopes] = useState<ReadonlyArray<(typeof PUNTOS_GITHUB_SCOPES)[number]>>([]);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const account = status.data;

  if (status.isPending && !account) {
    return <p className="text-sm text-muted-foreground">Revisando…</p>;
  }
  if (account) {
    return (
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
        <Badge variant="success">Conectado</Badge>
        <span className="min-w-0 flex-1 truncate">
          <strong>@{account.login}</strong>
          {account.orgs.length ? (
            <span className="text-muted-foreground"> · {account.orgs.join(", ")}</span>
          ) : null}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await logout({ environmentId, input: { id: agentId } });
            setDevice(null);
            status.refresh();
          }}
        >
          Desconectar
        </Button>
      </div>
    );
  }
  if (device) {
    return (
      <ol className="flex flex-col gap-3 rounded-lg border p-3 text-sm">
        <li className="flex flex-col gap-1.5">
          <span>1. Copia este código</span>
          <div className="flex items-center gap-2">
            <code className="font-mono text-lg font-semibold tracking-widest">{device.code}</code>
            <Button size="sm" variant="outline" onClick={() => copyToClipboard(device.code)}>
              {isCopied ? <CheckIcon /> : <CopyIcon />}
              {isCopied ? "Copiado" : "Copiar"}
            </Button>
          </div>
        </li>
        <li className="flex flex-col gap-1.5">
          <span>2. Ábrelo en GitHub, pega el código y aprueba</span>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => void readLocalApi()?.shell.openExternal(device.url)}
          >
            <ExternalLinkIcon />
            Abrir {device.url.replace(/^https?:\/\//, "")}
          </Button>
        </li>
        <li className="flex items-center gap-2">
          <span>3.</span>
          <Button size="sm" onClick={() => status.refresh()}>
            Ya lo aprobé
          </Button>
          <Button size="sm" variant="ghost-muted" onClick={() => setDevice(null)}>
            Cancelar
          </Button>
        </li>
      </ol>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">Sin conectar</Badge>
        <span className="text-muted-foreground">Usa su propia cuenta, no la tuya.</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Permisos extra (opcional)</span>
        <div className="flex flex-wrap gap-3">
          {PUNTOS_GITHUB_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1.5 text-xs">
              <Checkbox
                checked={scopes.includes(scope)}
                onCheckedChange={(checked) =>
                  setScopes(
                    checked === true ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                  )
                }
              />
              {scope}
            </label>
          ))}
        </div>
      </div>
      <Button
        size="sm"
        className="self-start"
        onClick={async () => {
          const result = await login({ environmentId, input: { id: agentId, scopes } });
          if (result._tag === "Success") setDevice(result.value);
        }}
      >
        Conectar GitHub
      </Button>
    </div>
  );
}
