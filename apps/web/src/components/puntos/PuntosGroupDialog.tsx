import type { EnvironmentId, PuntosAgent, PuntosGroup } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { puntosEnvironment } from "../../state/puntos";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { PuntosAvatar } from "./PuntosAvatar";

/** Create (`group === null`) or edit a group chat over some of the space's members. */
export function PuntosGroupDialog({
  environmentId,
  spaceId,
  members,
  group,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  /** The space's members; a group picks among them. */
  readonly members: ReadonlyArray<PuntosAgent>;
  readonly group: PuntosGroup | null;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(group?.name ?? "");
  // A new group starts with everyone in the space.
  const [memberIds, setMemberIds] = useState<ReadonlyArray<string>>(
    group?.memberIds ?? members.map((member) => member.id),
  );
  const [pending, setPending] = useState(false);
  const saveGroup = useAtomCommand(puntosEnvironment.saveGroup);
  const deleteGroup = useAtomCommand(puntosEnvironment.deleteGroup);

  const save = async () => {
    setPending(true);
    const result = await saveGroup({
      environmentId,
      input: { spaceId, ...(group ? { id: group.id } : {}), name: name.trim(), memberIds },
    });
    setPending(false);
    if (result._tag !== "Success") return;
    onClose();
    if (!group) {
      void navigate({
        to: "/puntos/$spaceId/$groupId",
        params: { spaceId, groupId: result.value.id },
      });
    }
  };
  const remove = async (target: PuntosGroup) => {
    if (!confirm(`¿Eliminar el grupo ${target.name}? Se borra su historial.`)) return;
    setPending(true);
    const result = await deleteGroup({ environmentId, input: { spaceId, id: target.id } });
    setPending(false);
    if (result._tag !== "Success") return;
    onClose();
    void navigate({ to: "/puntos/$spaceId", params: { spaceId }, replace: true });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{group ? group.name : "Nuevo grupo"}</DialogTitle>
          <DialogDescription>
            Un chat con algunos miembros del espacio. Cada miembro trabaja en su propio hilo.
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
              <Label htmlFor="puntos-group-name">Nombre</Label>
              <Input
                id="puntos-group-name"
                value={name}
                autoFocus
                placeholder="Diseño"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Miembros</Label>
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Este espacio aún no tiene miembros. Agrégalos desde la barra lateral.
                </p>
              ) : null}
              {members.map((member) => (
                <label key={member.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={memberIds.includes(member.id)}
                    onCheckedChange={(checked) =>
                      setMemberIds((current) =>
                        checked === true
                          ? [...current, member.id]
                          : current.filter((id) => id !== member.id),
                      )
                    }
                  />
                  <PuntosAvatar shape={member.shape} color={member.accentColor} />
                  {member.name}
                </label>
              ))}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          {group ? (
            <Button
              variant="destructive-outline"
              disabled={pending}
              onClick={() => void remove(group)}
            >
              Eliminar
            </Button>
          ) : null}
          <Button disabled={pending || !name.trim()} onClick={() => void save()}>
            {pending ? "Guardando…" : group ? "Guardar" : "Crear grupo"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
