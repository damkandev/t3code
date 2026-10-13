import { createPuntosEnvironmentAtoms } from "@t3tools/client-runtime/state/puntos";

import { connectionAtomRuntime } from "../connection/runtime";

export const puntosEnvironment = createPuntosEnvironmentAtoms(connectionAtomRuntime);
