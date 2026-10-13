import { createFileRoute } from "@tanstack/react-router";

import { PuntosPage } from "../components/puntos/PuntosPage";

export const Route = createFileRoute("/puntos/$spaceId/")({
  component: function PuntosSpaceRoute() {
    const { spaceId } = Route.useParams();
    return <PuntosPage spaceId={spaceId} />;
  },
});
