import { createFileRoute } from "@tanstack/react-router";

import { PuntosPage } from "../components/puntos/PuntosPage";

export const Route = createFileRoute("/puntos/")({
  component: () => <PuntosPage />,
});
