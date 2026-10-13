import { describe, expect, it } from "vite-plus/test";

import { memberInstructions } from "./instructions.ts";

describe("memberInstructions", () => {
  it("lists each space with its folders and members, and both ways of being talked to", () => {
    const text = memberInstructions({
      persona: { name: "Vale", prompt: "Eres Vale.", mounts: [{ host: "/Users/x/App", rw: true }] },
      spaces: [
        {
          name: "Acme",
          workdir: "/data/spaces/acme/files",
          folders: [{ host: "/Users/x/Acme", rw: false }],
          memory: "/data/spaces/acme/files/.puntos/MEMORIA.md",
          members: ["Vale", "Tomi"],
        },
        {
          name: "Casa",
          workdir: "/data/Mis Espacios/casa/files",
          folders: [],
          memory: "/data/Mis Espacios/casa/files/.puntos/MEMORIA.md",
          members: ["Vale"],
        },
      ],
      user: "Damián",
      outboxDir: "/data/agents/vale/home/outbox",
      notesPath: "/data/agents/vale/home/CLAUDE.md",
      hostKnowledgeDir: "/data/agents/vale/files",
    });
    expect(text.startsWith("Eres Vale.\n")).toBe(true);
    expect(text).toContain(
      "- «Acme». Carpeta de trabajo: /data/spaces/acme/files. Carpetas de la empresa: /Users/x/Acme (solo lectura). Miembros: Damián (humano), Vale, Tomi.",
    );
    expect(text).toContain(
      "- «Casa». Carpeta de trabajo: /data/Mis Espacios/casa/files. Miembros:",
    );
    expect(text).toContain("`Grupo «X» en «Espacio»`");
    expect(text).toContain("Directo:");
    expect(text).toContain("Tus carpetas: /Users/x/App (lectura y escritura).");
    expect(text).toContain("/data/agents/vale/home/outbox");
    expect(text).toContain("/data/agents/vale/home/CLAUDE.md");
    // Consulted from the user's code threads, it runs on the host where /knowledge is not mounted.
    expect(text).toContain("tus archivos de /knowledge están en /data/agents/vale/files");
  });

  it("imports each space's shared memory by name and lays out where memories go", () => {
    const text = memberInstructions({
      persona: { name: "Vale", prompt: "Eres Vale.", mounts: [] },
      spaces: [
        {
          name: "Acme",
          workdir: "/data/acme",
          folders: [],
          memory: "/data/acme/.puntos/MEMORIA.md",
          members: [],
        },
        {
          name: "Casa",
          workdir: "/data/Mis Espacios/casa",
          folders: [],
          memory: "/data/Mis Espacios/casa/.puntos/MEMORIA.md",
          members: [],
        },
      ],
      user: "Damián",
      outboxDir: "/out",
      notesPath: "/home/CLAUDE.md",
      hostKnowledgeDir: "/files",
    });
    // Claude Code `@path` imports end at the first unescaped space.
    expect(text).toContain("  - «Acme»: @/data/acme/.puntos/MEMORIA.md\n");
    expect(text).toContain("  - «Casa»: @/data/Mis\\ Espacios/casa/.puntos/MEMORIA.md\n");
    for (const section of ["## Sobre Damián", "## Decisiones", "## Pendientes", "## Personas"]) {
      expect(text).toContain(`\`${section}\``);
    }
    expect(text).toContain("`- AAAA-MM-DD: …`");
  });

  it("has no shared memory without spaces", () => {
    const text = memberInstructions({
      persona: { name: "Vale", prompt: "Eres Vale.", mounts: [] },
      spaces: [],
      user: "Damián",
      outboxDir: "/out",
      notesPath: "/home/CLAUDE.md",
      hostKnowledgeDir: "/files",
    });
    expect(text).toContain("- Tus apuntes, /home/CLAUDE.md:");
    expect(text).not.toContain("memoria de cada espacio");
    expect(text).not.toContain("@/");
  });
});
