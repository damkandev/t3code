import type { EnvironmentId, PuntosMount } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArrowUpIcon, FolderIcon, FolderPlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { isWindowsPlatform } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";

/** Folders a member sees, mounted in its container at the same path as on the host. */
export function PuntosFolderList({
  environmentId,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ReadonlyArray<PuntosMount>;
  readonly onChange: (next: ReadonlyArray<PuntosMount>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {value.map((mount) => (
        <FolderRow
          key={mount.host}
          mount={mount}
          onChange={(next) => onChange(value.map((m) => (m.host === mount.host ? next : m)))}
          onRemove={() => onChange(value.filter((m) => m.host !== mount.host))}
        />
      ))}
      <PickFolderButton
        environmentId={environmentId}
        label="Agregar carpeta"
        onPick={(host) => {
          if (!value.some((m) => m.host === host)) onChange([...value, { host, rw: false }]);
        }}
      />
    </div>
  );
}

function FolderRow({
  mount,
  onChange,
  onRemove,
}: {
  readonly mount: PuntosMount;
  readonly onChange: (next: PuntosMount) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{folderName(mount.host)}</p>
        <p className="truncate text-xs text-muted-foreground">{mount.host}</p>
      </div>
      <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {mount.rw ? "Puede editar" : "Solo lectura"}
        <Switch
          size="sm"
          checked={mount.rw}
          aria-label="Puede editar"
          onCheckedChange={(rw) => onChange({ ...mount, rw })}
        />
      </label>
      <Button size="icon-sm" variant="ghost-destructive" aria-label="Quitar" onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </div>
  );
}

/**
 * Picks a folder on the environment's machine, where the containers run. The desktop app's own
 * environment uses the native dialog; anything else (web, remote, WSL) browses the server.
 */
function PickFolderButton({
  environmentId,
  label,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onPick: (host: string) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverOs = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .platform.os;
  // A Linux server under a Windows desktop is WSL: the native dialog would return Windows paths.
  const native =
    environmentId === primaryEnvironmentId &&
    window.desktopBridge !== undefined &&
    serverOs !== undefined &&
    (serverOs === "windows") === isWindowsPlatform(navigator.platform);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={async () => {
          if (!native) {
            setBrowsing(true);
            return;
          }
          const host = await readLocalApi()
            ?.dialogs.pickFolder()
            .catch(() => null);
          if (host) onPick(host);
        }}
      >
        <FolderPlusIcon />
        {label}
      </Button>
      {browsing ? (
        <FolderBrowserDialog
          environmentId={environmentId}
          onClose={() => setBrowsing(false)}
          onPick={(host) => {
            setBrowsing(false);
            onPick(host);
          }}
        />
      ) : null}
    </>
  );
}

function FolderBrowserDialog({
  environmentId,
  onClose,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onPick: (host: string) => void;
}) {
  // Always ends with a separator, so the server lists this directory's children.
  const [path, setPath] = useState("~/");
  const access = useFilesystemReadAccess(environmentId);
  const browse = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.browse({ environmentId, input: { partialPath: path } })
      : null,
  );
  const current = browse.data?.parentPath ?? null;
  const sep = current?.includes("\\") && !current.includes("/") ? "\\" : "/";
  const atRoot = current === null || /^([\\/]|[A-Za-z]:[\\/]?)$/.test(current);
  const entries = (browse.data?.entries ?? []).filter((entry) => !entry.name.startsWith("."));
  const error = access.error ?? browse.error;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Elegir carpeta</DialogTitle>
          <DialogDescription>
            Carpetas del equipo donde corre T3 Code, que es donde viven los contenedores.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Subir un nivel"
              disabled={atRoot}
              onClick={() => current && setPath(`${trimSep(current)}${sep}..${sep}`)}
            >
              <ArrowUpIcon />
            </Button>
            <p className="min-w-0 flex-1 truncate font-mono text-xs">{current ?? path}</p>
          </div>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <div className="flex h-72 flex-col overflow-y-auto rounded-lg border p-1">
              {browse.isPending && !browse.data ? (
                <p className="p-2 text-sm text-muted-foreground">Cargando…</p>
              ) : entries.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">Sin subcarpetas.</p>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.fullPath}
                    type="button"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => setPath(`${entry.fullPath}${sep}`)}
                  >
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!current} onClick={() => current && onPick(trimSep(current))}>
            Elegir esta carpeta
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function trimSep(path: string): string {
  return path.length > 1 && !/^[A-Za-z]:[\\/]$/.test(path) ? path.replace(/[\\/]+$/, "") : path;
}

function folderName(host: string): string {
  return host.split(/[\\/]/).findLast(Boolean) ?? host;
}
