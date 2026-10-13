// @effect-diagnostics nodeBuiltinImport:off - Puntos writes a few small host files (the wrapper, notes).
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PuntosError, type PuntosGithubStatus, type PuntosMount } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";
import { homeDir, type Persona, wrapperPath } from "./personas.ts";

export const IMAGE = "puntos-agent";

// Built from stdin, so there is no build context: keep it free of COPY/ADD.
// socat bridges T3's MCP endpoint into the container (see `bridgeMcp`).
const DOCKERFILE = `FROM node:24-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git gh python3 python3-pip curl ca-certificates socat procps \\
 && rm -rf /var/lib/apt/lists/*
RUN npm i -g @anthropic-ai/claude-code
RUN git config --system credential.https://github.com.helper '!gh auth git-credential'
# claude --dangerously-skip-permissions refuses to run as root
RUN useradd -m -d /home/agent -s /bin/bash agent
USER agent
WORKDIR /home/agent
CMD ["sleep", "infinity"]
`;

const DOCKER = process.env.PUNTOS_DOCKER || "docker";
export const containerName = (id: string) => `puntos-${id}`;

/**
 * Host paths a member's container mounts at the same path, so the member and the user name the
 * same folders: T3's attachments plus, for each space it belongs to, the space's working folder
 * (its threads' cwd) and company folder.
 */
export interface HostPaths {
  readonly attachmentsDir: string;
  readonly workdirs: ReadonlyArray<string>;
  readonly folders: ReadonlyArray<PuntosMount>;
}

/** Where a member drops files to attach to its group reply; its home is already mounted. */
export const outboxDir = (persona: Pick<Persona, "dir">) =>
  NodePath.join(homeDir(persona), "outbox");

export function mountArgs(persona: Persona, paths: HostPaths): string[] {
  // A folder can come from the member and from several spaces: mount it once, writable if any is.
  const folders = new Map<string, boolean>();
  for (const m of [...persona.mounts, ...paths.folders]) {
    folders.set(m.host, (folders.get(m.host) ?? false) || m.rw);
  }
  return [
    // Its own Linux home: gh login, cloned repos, tool caches.
    `${containerName(persona.id)}-home:/home/agent`,
    `${homeDir(persona)}:${homeDir(persona)}`,
    `${NodePath.join(persona.dir, "files")}:/knowledge:ro`,
    ...paths.workdirs.map((dir) => `${dir}:${dir}`),
    `${paths.attachmentsDir}:${paths.attachmentsDir}:ro`,
    ...[...folders].map(([host, rw]) => `${host}:${host}${rw ? "" : ":ro"}`),
  ].flatMap((v) => ["-v", v]);
}

const run = (args: ReadonlyArray<string>, options: { readonly stdin?: string } = {}) =>
  Effect.flatMap(ProcessRunner.ProcessRunner, (runner) =>
    runner.run({
      command: DOCKER,
      args,
      timeout: "10 minutes",
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    }),
  ).pipe(Effect.mapError((cause) => new PuntosError({ message: cause.message })));

const must = (args: ReadonlyArray<string>, options?: { readonly stdin?: string }) =>
  run(args, options).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new PuntosError({
              message: `docker ${args[0]} falló: ${(result.stderr || result.stdout).trim()}`,
            }),
          ),
    ),
  );

export const ensureImage = Effect.gen(function* () {
  if ((yield* run(["image", "inspect", IMAGE])).code === 0) return;
  yield* must(["build", "-t", IMAGE, "-"], { stdin: DOCKERFILE });
});

/**
 * Starts the member's container (recreating it when its mounts or the image changed), bridges
 * T3's MCP endpoint into it, and carries over notes from the pre-instance layout.
 */
export const ensureContainer = Effect.fn("puntos.ensureContainer")(function* (
  persona: Persona,
  paths: HostPaths,
  mcpPort: number | null,
) {
  for (const dir of paths.workdirs) NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(persona.dir, "files"), { recursive: true });
  NodeFS.mkdirSync(outboxDir(persona), { recursive: true });
  const name = containerName(persona.id);
  // Docker Desktop (macOS/Windows) runs containers in a VM, so host networking does not reach the
  // host's loopback; Linux shares it directly.
  const hostNetwork = (yield* HostProcess.Platform) === "linux";
  const args = [
    ...mountArgs(persona, paths),
    ...(hostNetwork ? ["--network", "host"] : ["--add-host", "host.docker.internal:host-gateway"]),
    // The member's commits go out under its own name.
    "-e",
    `GIT_AUTHOR_NAME=${persona.name}`,
    "-e",
    `GIT_COMMITTER_NAME=${persona.name}`,
    "-e",
    `GIT_AUTHOR_EMAIL=${persona.id}@puntos.local`,
    "-e",
    `GIT_COMMITTER_EMAIL=${persona.id}@puntos.local`,
  ];
  yield* ensureImage;
  // The hash covers the image too: a rebuilt image recreates the container; the home volume stays.
  const image = (yield* must(["image", "inspect", "-f", "{{.Id}}", IMAGE])).stdout.trim();
  const hash = NodeCrypto.createHash("sha1")
    .update([image, ...args].join("\0"))
    .digest("hex");
  const current = yield* run([
    "inspect",
    "-f",
    '{{.State.Running}} {{index .Config.Labels "puntos.mounts"}}',
    name,
  ]);
  const [running, label] = current.stdout.trim().split(" ");
  if (current.code !== 0 || label !== hash) {
    if (current.code === 0) yield* must(["rm", "-f", name]);
    yield* must(["run", "-d", "--name", name, "--label", `puntos.mounts=${hash}`, ...args, IMAGE]);
  } else if (running !== "true") {
    yield* must(["start", name]);
  }
  yield* importLegacyNotes(persona);
  if (mcpPort !== null && !hostNetwork) yield* bridgeMcp(name, mcpPort);
});

/**
 * T3 hands Claude its MCP endpoint as `127.0.0.1:<port>`. Without host networking, socat listens
 * there inside the container and forwards to the host. Restarted on every ensure, since the server
 * port can change between runs.
 */
const bridgeMcp = (name: string, port: number) =>
  must([
    "exec",
    "-d",
    "-u",
    "root",
    name,
    "sh",
    "-c",
    `pkill -x socat; exec socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr TCP:host.docker.internal:${port}`,
  ]).pipe(Effect.asVoid);

/** Before members were provider instances, their notes lived in the container's ~/.claude. */
const importLegacyNotes = (persona: Persona) =>
  Effect.gen(function* () {
    const notes = NodePath.join(homeDir(persona), "CLAUDE.md");
    if (NodeFS.existsSync(notes)) return;
    const legacy = yield* run([
      "exec",
      containerName(persona.id),
      "cat",
      "/home/agent/.claude/CLAUDE.md",
    ]);
    NodeFS.writeFileSync(notes, legacy.code === 0 ? legacy.stdout : "");
  });

export const removeContainer = (id: string, { wipeHome = false } = {}) =>
  Effect.gen(function* () {
    yield* run(["rm", "-f", containerName(id)]);
    if (wipeHome) yield* run(["volume", "rm", `${containerName(id)}-home`]);
  });

/**
 * The executable the member's provider instance runs: Claude Code inside its container, with the
 * Claude/Anthropic variables T3 set forwarded. cwd falls back to the home when the caller's
 * directory is not mounted (T3's `--version` probe runs from the server's cwd).
 */
export function writeWrapper(persona: Persona): string {
  const file = wrapperPath(persona);
  NodeFS.writeFileSync(
    file,
    `#!/bin/sh
# Written by T3 Code Puntos for ${persona.id}: runs Claude Code inside its Docker container.
env_args=""
for name in $(env | grep -E '^(CLAUDE|ANTHROPIC|MCP|DISABLE|ENABLE|MAX|OTEL|BASH)_[A-Za-z0-9_]*=' | cut -d= -f1); do
  env_args="$env_args -e $name"
done
# Auto memory off: the member keeps its memory in its notes and its spaces' MEMORIA.md.
exec ${DOCKER} exec -i -e CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 $env_args ${containerName(persona.id)} sh -c 'cd "$0" 2>/dev/null || cd; exec claude "$@"' "$(pwd)" "$@"
`,
    { mode: 0o755 },
  );
  NodeFS.chmodSync(file, 0o755);
  return file;
}

/** One-shot structured `claude -p` through a member's wrapper (used by the router). */
export const runClaudeJson = Effect.fn("puntos.runClaudeJson")(function* (
  persona: Persona,
  input: { prompt: string; systemPrompt: string; schema: string; model: string; token: string },
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({
      command: wrapperPath(persona),
      args: [
        "-p",
        "--model",
        input.model,
        "--setting-sources",
        "",
        "--tools",
        "",
        "--no-session-persistence",
        "--system-prompt",
        input.systemPrompt,
        "--output-format",
        "json",
        "--json-schema",
        input.schema,
      ],
      stdin: input.prompt,
      timeout: "2 minutes",
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: input.token,
        CLAUDE_CONFIG_DIR: homeDir(persona),
      },
    })
    .pipe(Effect.mapError((cause) => new PuntosError({ message: cause.message })));
  if (result.code !== 0)
    return yield* Effect.fail(new PuntosError({ message: result.stderr || result.stdout }));
  return (JSON.parse(result.stdout) as { structured_output?: unknown }).structured_output;
});

// --- GitHub: device-flow login inside the container; the token lives in the member's home ---

export const githubStatus = (id: string) =>
  Effect.gen(function* () {
    const user = yield* run(["exec", containerName(id), "gh", "api", "-i", "user"]);
    if (user.code !== 0) return null;
    const login = user.stdout.match(/"login":\s*"([^"]+)"/)?.[1];
    if (!login) return null;
    const scopes = (user.stdout.match(/^x-oauth-scopes:(.*)$/im)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const orgs = yield* run([
      "exec",
      containerName(id),
      "gh",
      "api",
      "user/orgs",
      "--paginate",
      "-q",
      ".[].login",
    ]);
    const status: PuntosGithubStatus = {
      login,
      scopes,
      orgs: orgs.code === 0 ? orgs.stdout.split("\n").filter(Boolean) : [],
    };
    return status;
  });

export const githubLogout = (id: string) =>
  run(["exec", containerName(id), "gh", "auth", "logout", "--hostname", "github.com"]).pipe(
    Effect.asVoid,
  );

/** The device code in `gh auth login --web` output, once it is complete (chunks can split it). */
export const githubDeviceCode = (output: string) =>
  output.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1] ?? null;

/**
 * Resolves `{ code, url }` once gh prints the device code; the login keeps running in the
 * background until it is approved or expires.
 */
export const githubLogin = Effect.fn("puntos.githubLogin")(function* (
  id: string,
  scopes: ReadonlyArray<string>,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const device = yield* Deferred.make<{ code: string; url: string }, PuntosError>();
  let output = "";
  const login = [
    "gh auth login --hostname github.com --git-protocol https --web",
    ...(scopes.length ? [`--scopes ${scopes.join(",")}`] : []),
  ].join(" ");
  yield* runner
    .run({
      command: DOCKER,
      // gh prints the code on stderr and waits for Enter before "opening the browser".
      args: ["exec", "-i", containerName(id), "sh", "-c", `${login} 2>&1`],
      stdin: "\n",
      timeout: "15 minutes",
      onStdoutChunk: (chunk) => {
        output += new TextDecoder().decode(chunk);
        const code = githubDeviceCode(output);
        if (code)
          Deferred.doneUnsafe(
            device,
            Effect.succeed({ code, url: "https://github.com/login/device" }),
          );
      },
    })
    .pipe(
      Effect.tap(() =>
        Deferred.fail(
          device,
          new PuntosError({ message: output.trim() || "gh auth login terminó sin código" }),
        ),
      ),
      Effect.catch((cause) => Deferred.fail(device, new PuntosError({ message: cause.message }))),
      Effect.forkDetach,
    );
  // gh prints the code within seconds; past a minute it is stuck, so stop waiting on it.
  return yield* Deferred.await(device).pipe(
    Effect.timeoutOrElse({
      duration: "1 minute",
      orElse: () =>
        Effect.fail(
          new PuntosError({ message: output.trim() || "gh auth login no entregó un código" }),
        ),
    }),
  );
});
