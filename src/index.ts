/**
 * pi-bridge: makes a pi session addressable from Claude Code's cross-session
 * messaging tools (ListAgents / SendMessage).
 *
 * Claude Code discovers peers by reading ~/.claude/sessions/<pid>.json and
 * liveness-probing each record's messagingSocketPath. This extension writes
 * such a record for the pi process and serves the same newline-delimited JSON
 * protocol on a unix socket, so pi shows up as just another peer session.
 *
 * The reverse-engineered protocol is documented in the cc-pi repository.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const PROBE_TIMEOUT_MS = 250;
const MAX_PEER_FRAME_BYTES = 1_048_576;

function resolveSessionsDir(): string {
  const configDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDirectory, "sessions");
}

type SessionRecord = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: string;
  messagingSocketPath: string;
  peerProtocol: number | undefined;
  startedAt: number | undefined;
};

type PeerFrame = {
  msgV: number;
  msg_id: string;
  type: "user";
  message: { role: "user"; content: string };
  priority: "next";
  from: string;
};

/** Claude derives this from XDG_RUNTIME_DIR or its tmpdir. Follow whatever live sessions already use so we land in the same namespace. */
function resolveSocketDir(): string {
  for (const record of readRecords()) {
    if (record.messagingSocketPath) return dirname(record.messagingSocketPath);
  }
  return join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "cc-socks");
}

function readRecords(): SessionRecord[] {
  let files: string[];
  try {
    files = readdirSync(resolveSessionsDir());
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(
        readFileSync(join(resolveSessionsDir(), file), "utf8"),
      ) as SessionRecord;
      if (typeof record.messagingSocketPath === "string") records.push(record);
    } catch {
      // A session record mid-write is not worth failing discovery over.
    }
  }
  return records;
}

function isLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ path: socketPath });
    const settle = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.on("connect", () => settle(true));
    probe.on("error", () => settle(false));
    probe.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
  });
}

function ref(record: SessionRecord): string {
  return (record.sessionId ?? "").replace(/-/g, "").slice(0, 6);
}

/** Accepts a bare name, a "name [ref]" from a listing, or a raw uds:/path address. */
function resolveTarget(
  to: string,
  selfPid: number,
): { path: string; label: string } | { error: string } {
  const trimmed = to.trim();
  if (trimmed.startsWith("uds:")) return { path: trimmed.slice(4), label: trimmed };
  if (trimmed.startsWith("/")) return { path: trimmed, label: `uds:${trimmed}` };

  const match = /^(.*?)\s*\[([0-9a-f]+)\]$/.exec(trimmed);
  const wantedName = (match?.[1] ?? trimmed).trim();
  const wantedRef = match?.[2];

  const candidates = readRecords().filter(
    (record) =>
      record.pid !== selfPid &&
      record.name === wantedName &&
      (!wantedRef || ref(record).startsWith(wantedRef)),
  );
  const candidate = candidates[0];
  if (!candidate)
    return {
      error: `No peer named '${wantedName}'. Run list_agents to see current peers.`,
    };
  if (candidates.length > 1) {
    const refs = candidates.map((record) => `${record.name} [${ref(record)}]`).join(", ");
    return {
      error: `'${wantedName}' is ambiguous. Re-send with a ref: ${refs}`,
    };
  }
  return { path: candidate.messagingSocketPath, label: candidate.name };
}

function sendFrame(socketPath: string, frame: PeerFrame): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = connect({ path: socketPath }, () => {
      conn.end(`${JSON.stringify(frame)}\n`, () => resolve());
    });
    conn.setTimeout(5000, () => {
      conn.destroy();
      reject(new Error(`Timed out writing to ${socketPath}`));
    });
    conn.on("error", reject);
  });
}

/**
 * Registers the opt-in Claude Code peer integration.
 *
 * @param pi - Pi extension API used to register flags, lifecycle handlers, and peer tools.
 */
export default function piBridge(pi: ExtensionAPI): void {
  pi.registerFlag("bridge", {
    description: "Make this pi session addressable from Claude Code peer messaging",
    type: "boolean",
    default: false,
  });

  const pid = process.pid;
  let socketPath = "";
  let recordPath = "";
  let selfAddress = "";
  let sessionId = "";
  let startedAt = 0;
  const name = `pi-${basename(process.cwd()).replace(/[^A-Za-z0-9_-]/g, "-")}-${pid}`.slice(0, 80);
  let streaming = false;
  let toolsRegistered = false;

  const runtime = (() => {
    let server: Server | undefined;
    const connections = new Set<Socket>();
    let running = false;
    let recordPublished = false;
    let socketIdentity: { device: number; inode: number } | undefined;
    let degradationWarned = false;

    const createRecord = (status: "busy" | "idle") => {
      const now = Date.now();
      return {
        pid,
        sessionId,
        cwd: process.cwd(),
        startedAt,
        procStart: new Date(startedAt).toString(),
        version: `pi-${process.env.PI_VERSION ?? "0.84.0"}`,
        peerProtocol: 1,
        kind: "interactive",
        entrypoint: "cli",
        messagingSocketPath: socketPath,
        name,
        nameSource: "derived",
        status,
        updatedAt: now,
        statusUpdatedAt: now,
        _piBridge: { recordVersion: 1 },
      };
    };

    const prepareDirectory = (path: string, createdDirectories: string[]) => {
      const missingDirectories: string[] = [];
      let cursor = path;
      while (true) {
        try {
          const stat = lstatSync(cursor);
          if (!stat.isDirectory()) throw new Error(`${cursor} is not a directory`);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          missingDirectories.push(cursor);
          const parent = dirname(cursor);
          if (parent === cursor) throw error;
          cursor = parent;
        }
      }

      for (const missingDirectory of [...missingDirectories].reverse()) {
        try {
          mkdirSync(missingDirectory, { mode: 0o700 });
          createdDirectories.unshift(missingDirectory);
          chmodSync(missingDirectory, 0o700);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!lstatSync(missingDirectory).isDirectory()) {
            throw new Error(`${missingDirectory} is not a directory`);
          }
        }
      }
    };

    const temporaryRecordPath = () =>
      join(dirname(recordPath), `.${basename(recordPath)}.${randomUUID()}.tmp`);

    const withTemporaryRecord = (
      status: "busy" | "idle",
      publish: (temporaryPath: string) => void,
    ) => {
      const temporaryPath = temporaryRecordPath();
      try {
        writeFileSync(temporaryPath, JSON.stringify(createRecord(status)), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        chmodSync(temporaryPath, 0o600);
        publish(temporaryPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    };

    const publishInitialRecord = () => {
      withTemporaryRecord("idle", (temporaryPath) => {
        linkSync(temporaryPath, recordPath);
        recordPublished = true;
      });
    };

    const rewriteRecord = (status: "busy" | "idle") => {
      withTemporaryRecord(status, (temporaryPath) => renameSync(temporaryPath, recordPath));
    };

    const closeServer = async () => {
      const currentServer = server;
      if (!currentServer?.listening) return;
      await new Promise<void>((resolve) => currentServer.close(() => resolve()));
    };

    const removeOwnedRecord = () => {
      if (!recordPublished) return;
      try {
        const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
          sessionId: unknown;
          _piBridge: { recordVersion: unknown } | undefined;
        };
        if (record.sessionId !== sessionId || record._piBridge?.recordVersion !== 1) return;
        rmSync(recordPath);
      } catch {
        // Leave anything whose ownership cannot be proven.
      }
    };

    const removeOwnedSocket = () => {
      if (!socketIdentity) return;
      try {
        const stat = lstatSync(socketPath);
        if (stat.dev !== socketIdentity.device || stat.ino !== socketIdentity.inode) return;
        rmSync(socketPath);
      } catch {
        // The socket may already have been removed.
      }
    };

    const reset = () => {
      server = undefined;
      running = false;
      recordPublished = false;
      socketIdentity = undefined;
      degradationWarned = false;
    };

    const stop = async () => {
      for (const connection of connections) connection.destroy();
      connections.clear();
      await closeServer();
      removeOwnedRecord();
      removeOwnedSocket();
      reset();
    };

    const rollback = async (createdDirectories: string[]) => {
      await stop();
      for (const path of createdDirectories) {
        try {
          rmdirSync(path);
        } catch {
          // Keep pre-existing or now non-empty directories.
        }
      }
    };

    const start = async (ctx: ExtensionContext) => {
      if (running) return;
      const createdDirectories: string[] = [];
      try {
        const sessionsDir = resolveSessionsDir();
        prepareDirectory(sessionsDir, createdDirectories);
        const socketDir = resolveSocketDir();
        prepareDirectory(socketDir, createdDirectories);

        socketPath = join(socketDir, `${pid}.sock`);
        recordPath = join(sessionsDir, `${pid}.json`);
        selfAddress = `uds:${socketPath}`;
        sessionId = randomUUID();
        startedAt = Date.now();

        const nextServer = createServer({ allowHalfOpen: true }, (connection) => {
          connections.add(connection);
          let pendingFrame = Buffer.alloc(0);
          let rejected = false;

          const rejectOversizedFrame = () => {
            if (rejected) return;
            rejected = true;
            pendingFrame = Buffer.alloc(0);
            ctx.ui.notify(
              `pi-bridge: peer frame exceeds ${MAX_PEER_FRAME_BYTES} byte limit`,
              "warning",
            );
            connection.destroy();
          };

          const appendToPendingFrame = (bytes: Buffer): boolean => {
            const nextLength = pendingFrame.length + bytes.length;
            if (nextLength > MAX_PEER_FRAME_BYTES) {
              rejectOversizedFrame();
              return false;
            }
            if (bytes.length === 0) return true;
            pendingFrame =
              pendingFrame.length === 0
                ? Buffer.from(bytes)
                : Buffer.concat([pendingFrame, bytes], nextLength);
            return true;
          };

          const processPendingFrame = () => {
            const line = pendingFrame.toString("utf8");
            pendingFrame = Buffer.alloc(0);
            if (line.trim()) handleLine(line, ctx);
          };

          connection.on("data", (chunk) => {
            let offset = 0;
            while (offset < chunk.length && !rejected) {
              const newlineIndex = chunk.indexOf(0x0a, offset);
              if (newlineIndex === -1) {
                appendToPendingFrame(chunk.subarray(offset));
                return;
              }

              if (!appendToPendingFrame(chunk.subarray(offset, newlineIndex))) return;
              processPendingFrame();
              offset = newlineIndex + 1;
            }
          });
          connection.on("end", () => {
            if (rejected) return;
            if (pendingFrame.length > 0) processPendingFrame();
            connection.end();
          });
          connection.on("close", () => connections.delete(connection));
          connection.on("error", () => connections.delete(connection));
        });
        server = nextServer;

        await new Promise<void>((resolve, reject) => {
          const handleStartupError = (error: Error) => reject(error);
          nextServer.once("error", handleStartupError);
          nextServer.listen(socketPath, () => {
            nextServer.off("error", handleStartupError);
            resolve();
          });
        });

        const socketStat = lstatSync(socketPath);
        socketIdentity = { device: socketStat.dev, inode: socketStat.ino };
        chmodSync(socketPath, 0o600);
        nextServer.unref();
        nextServer.on("error", (error) =>
          ctx.ui.notify(`pi-bridge: server error: ${error.message}`, "error"),
        );
        publishInitialRecord();
        running = true;
      } catch (error) {
        await rollback(createdDirectories);
        throw error;
      }
    };

    const updateStatus = (status: "busy" | "idle", ctx: ExtensionContext) => {
      if (!running) return;
      try {
        rewriteRecord(status);
      } catch (error) {
        if (degradationWarned) return;
        degradationWarned = true;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-bridge: session status updates degraded: ${message}`, "warning");
      }
    };

    return { start, updateStatus, stop };
  })();

  const deliver = (content: string, ctx: ExtensionContext) => {
    // sendUserMessage throws when the agent is mid-stream unless told how to queue.
    if (streaming) {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
      return;
    }
    pi.sendUserMessage(content);
    ctx.ui.notify("Peer message received", "info");
  };

  const handleLine = (line: string, ctx: ExtensionContext) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line);
    } catch {
      ctx.ui.notify(`pi-bridge: unparseable frame: ${line.slice(0, 120)}`, "warning");
      return;
    }

    if (frame.action === "peer_message_status") {
      ctx.ui.notify(
        `pi-bridge: delivery ${String(frame.status)} for ${String(frame.orig_msg_id ?? "")}`,
        "info",
      );
      return;
    }
    if (frame.type !== "user") return;

    const message = frame.message as { content?: unknown } | undefined;
    const content = typeof message?.content === "string" ? message.content : undefined;
    if (!content) return;

    // Claude wraps the body in <cross-session-message from="uds:..."> already, which
    // carries the reply address the send_message tool needs. Pass it through intact.
    deliver(content, ctx);
  };

  const registerTools = () => {
    if (toolsRegistered) return;
    toolsRegistered = true;

    pi.registerTool({
      name: "list_agents",
      label: "List agents",
      description:
        "List live peer sessions on this machine (Claude Code sessions and other pi-bridge sessions). " +
        "Returns each peer's name, ref, status, and working directory. Use the name as the 'to' argument of send_message.",
      parameters: Type.Object({}),
      async execute() {
        const records = readRecords().filter((record) => record.pid !== pid);
        const live = await Promise.all(
          records.map(async (record) =>
            (await isLive(record.messagingSocketPath)) ? record : undefined,
          ),
        );
        const peers = live.filter((record): record is SessionRecord => record !== undefined);
        if (peers.length === 0) {
          return {
            content: [{ type: "text", text: "No live peer sessions." }],
            details: {},
          };
        }
        const lines = peers.map(
          (record) =>
            `${record.name} [${ref(record)}]  ·  ${record.status ?? "unknown"}  ·  ${record.cwd}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Peer sessions (${peers.length}):\n${lines.join("\n")}`,
            },
          ],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "send_message",
      label: "Send message",
      description:
        "Send a message to a peer session. 'to' takes a name from list_agents, a 'name [ref]' when a name is ambiguous, " +
        "or a raw uds: address. To reply to an incoming <cross-session-message>, pass its from= attribute as 'to'. " +
        "Your plain output is NOT visible to peers; this tool is the only way to reach them.",
      parameters: Type.Object({
        to: Type.String({
          description: "Peer name, 'name [ref]', or uds: address",
        }),
        message: Type.String({ description: "Message body" }),
      }),
      async execute(_toolCallId, params) {
        const target = resolveTarget(params.to, pid);
        if ("error" in target) throw new Error(target.error);
        const frame: PeerFrame = {
          msgV: 1,
          msg_id: randomUUID(),
          type: "user",
          message: {
            role: "user",
            content:
              `<cross-session-message from="${selfAddress}" from-name="${name}" from-mode="prompting">\n` +
              `${params.message}\n</cross-session-message>`,
          },
          priority: "next",
          from: selfAddress,
        };
        await sendFrame(target.path, frame);
        return {
          content: [
            {
              type: "text",
              text: `Delivered to ${target.label} (msg_id ${frame.msg_id})`,
            },
          ],
          details: {},
        };
      },
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("bridge")) return;
    try {
      await runtime.start(ctx);
      registerTools();
      ctx.ui.setStatus("pi-bridge", `peer: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-bridge: startup failed, bridge disabled: ${message}`, "error");
    }
  });
  pi.on("session_shutdown", async () => runtime.stop());
  pi.on("agent_start", async (_event, ctx) => {
    streaming = true;
    runtime.updateStatus("busy", ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    streaming = false;
    runtime.updateStatus("idle", ctx);
  });
}
