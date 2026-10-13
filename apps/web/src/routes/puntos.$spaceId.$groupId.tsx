import { createFileRoute } from "@tanstack/react-router";

import { PuntosPage } from "../components/puntos/PuntosPage";

export const Route = createFileRoute("/puntos/$spaceId/$groupId")({
  component: function PuntosGroupRoute() {
    const { spaceId, groupId } = Route.useParams();
    return <PuntosPage spaceId={spaceId} groupId={groupId} />;
  },
});
