import type { MemberContextRecord } from "@t3tools/contracts";
import { UserRoundIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { ContextChip, ContextChipLabel } from "./ContextChip";

/** Inline chip for an addressed Puntos member, in the composer and in sent messages. */
export function MemberContextChip(props: {
  record: Pick<MemberContextRecord, "name" | "accentColor">;
  copyMarkdown?: string;
}) {
  return (
    <ContextChip
      kind="member"
      aria-label={`Puntos member, ${props.record.name}`}
      data-markdown-copy={props.copyMarkdown}
      style={
        props.record.accentColor
          ? ({ "--context-chip-accent": props.record.accentColor } as CSSProperties)
          : undefined
      }
    >
      <UserRoundIcon />
      <ContextChipLabel>{props.record.name}</ContextChipLabel>
    </ContextChip>
  );
}
