import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PUNTOS_GROUP_STATE,
  reducePuntosGroupState,
  type PuntosGroupEvent,
} from "./puntos.ts";

const fold = (events: PuntosGroupEvent[]) =>
  events.reduce(reducePuntosGroupState, EMPTY_PUNTOS_GROUP_STATE);
const message = (id: string) => ({
  id,
  ts: 0,
  author: "vale",
  text: id,
  attachments: [],
  renders: [],
  threadId: null,
});

describe("reducePuntosGroupState", () => {
  it("ignores a message that arrives in both the snapshot and the live stream", () => {
    const state = fold([
      { _tag: "snapshot", busy: false, messages: [message("m1")] },
      { _tag: "message", message: message("m1") },
      { _tag: "message", message: message("m2") },
    ]);
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("keeps a round's errors until the next round starts", () => {
    const failed = fold([
      { _tag: "status", busy: true },
      { _tag: "error", agentId: "vale", error: "boom" },
      { _tag: "status", busy: false },
    ]);
    expect(failed.errors).toHaveLength(1);
    expect(reducePuntosGroupState(failed, { _tag: "status", busy: true }).errors).toEqual([]);
  });
});
