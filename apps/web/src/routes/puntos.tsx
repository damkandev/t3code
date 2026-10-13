import { createFileRoute, redirect } from "@tanstack/react-router";

/** Auth gate for every Puntos page; the children pick the space and group. */
export const Route = createFileRoute("/puntos")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
});
