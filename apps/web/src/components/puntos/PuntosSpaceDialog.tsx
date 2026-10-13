import type { EnvironmentId, PuntosMount, PuntosSpace } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { puntosEnvironment } from "../../state/puntos";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { PuntosFolderList } from "./PuntosFolderPicker";

/** Create (`space === null`) or edit a space: an empresa or project with its own members. */
export function PuntosSpaceDialog({
  environmentId,
  space,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly space: PuntosSpace | null;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(space?.name ?? "");
  const [folders, setFolders] = useState<ReadonlyArray<PuntosMount>>(space?.folders ?? []);
  const [pending, setPending] = useState(false);
  const saveSpace = useAtomCommand(puntosEnvironment.saveSpace);
  const deleteSpace = useAtomCommand(puntosEnvironment.deleteSpace);

  const save = async () => {
    setPending(true);
    const result = await saveSpace({
      environmentId,
      input: { ...(space ? { id: space.id } : {}), name: name.trim(), folders },
    });
    setPending(false);
    if (result._tag !== "Success") return;
    onClose();
    if (!space) {
      void navigate({ to: "/puntos/$spaceId", params: { spaceId: result.value.id } });
    }
  };
  // The server refuses while some member belongs only to this space; that error shows as a toast.
  const remove = async (target: PuntosSpace) => {
    if (!confirm(`¿Eliminar el espacio ${target.name} y sus grupos?`)) return;
    setPending(true);
    const result = await deleteSpace({ environmentId, input: { id: target.id } });
    setPending(false);
    if (result._tag !== "Success") return;
    onClose();
    void navigate({ to: "/puntos", replace: true });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{space ? space.name : "Nuevo espacio"}</DialogTitle>
          <DialogDescription>
            Un espacio por empresa o proyecto, con sus propios miembros y grupos.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !pending) void save();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="puntos-space-name">Nombre</Label>
              <Input
                id="puntos-space-name"
                value={name}
                autoFocus
                placeholder="Acme"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Carpetas de la empresa (opcional)</Label>
              <p className="text-xs text-muted-foreground">
                Todos los miembros del espacio las ven, en la misma ruta que en tu PC.
              </p>
              <PuntosFolderList
                environmentId={environmentId}
                value={folders}
                onChange={setFolders}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          {space ? (
            <Button
              variant="destructive-outline"
              disabled={pending}
              onClick={() => void remove(space)}
            >
              Eliminar
            </Button>
          ) : null}
          <Button disabled={pending || !name.trim()} onClick={() => void save()}>
            {pending ? "Guardando…" : space ? "Guardar" : "Crear espacio"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
