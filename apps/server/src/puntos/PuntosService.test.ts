import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectReply } from "./PuntosService.ts";

const run = RunId.make("run-1");
const other = RunId.make("run-0");
const image = { type: "image", id: "puntos-a", name: "a.png", mimeType: "image/png", sizeBytes: 1 };
const page = { attachmentId: "t-html-1", title: "Demo", height: 400 };

const message = (runId: RunId, role: string, text: string, attachments: unknown[] = []) => ({
  runId,
  role,
  text,
  attachments,
});
const tool = (runId: RunId, status: string, output: unknown) => ({
  type: "dynamic_tool",
  runId,
  status,
  toolName: "mcp__t3-code__html_render",
  output,
});

describe("collectReply", () => {
  it("posts the run's last words, every file it sent and its published pages", () => {
    const reply = collectReply(
      {
        messages: [
          message(other, "assistant", "De la ronda anterior"),
          message(run, "user", "[Damián]: hola"),
          message(run, "assistant", "Reviso el repo…", [image]),
          message(run, "assistant", "  Listo, te dejé la demo.  "),
          message(run, "assistant", ""),
        ],
        turnItems: [
          tool(run, "completed", { htmlRender: page }),
          tool(run, "failed", { htmlRender: { ...page, attachmentId: "t-html-2" } }),
          tool(other, "completed", { htmlRender: { ...page, attachmentId: "t-html-3" } }),
        ],
      } as never,
      run,
    );
    expect(reply.text).toBe("Listo, te dejé la demo.");
    expect(reply.attachments).toEqual([image]);
    expect(reply.renders.map((render) => render.attachmentId)).toEqual(["t-html-1"]);
  });
});
