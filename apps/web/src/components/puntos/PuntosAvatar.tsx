import type { PuntosShape } from "@t3tools/contracts";

import { cn } from "../../lib/utils";

// Same-color round strokes soften the polygon corners without extra geometry.
const SHAPES: Record<PuntosShape, React.ReactNode> = {
  circle: <circle cx="12" cy="12" r="9" />,
  square: <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />,
  triangle: <path d="M12 5 19.5 18.5h-15Z" strokeWidth="3" />,
  hexagon: <path d="M12 3.6 19.3 7.8v8.4L12 20.4l-7.3-4.2V7.8Z" strokeWidth="2" />,
  diamond: <path d="M12 3.5 20.5 12 12 20.5 3.5 12Z" strokeWidth="2" />,
};

/** A member's shape in its provider instance's accent color. */
export function PuntosAvatar({
  shape,
  color = "var(--muted-foreground)",
  className,
}: {
  readonly shape: PuntosShape;
  readonly color?: string | undefined;
  readonly className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      fill={color}
      stroke={color}
      strokeWidth="0"
      strokeLinejoin="round"
    >
      {SHAPES[shape]}
    </svg>
  );
}
