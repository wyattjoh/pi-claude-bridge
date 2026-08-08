/**
 * cc-peer: makes a pi session addressable from Claude Code's cross-session
 * messaging tools (ListAgents / SendMessage).
 *
 * Claude Code discovers peers by reading ~/.claude/sessions/<pid>.json and
 * liveness-probing each record's messagingSocketPath. This extension writes
 * such a record for the pi process and serves the same newline-delimited JSON
 * protocol on a unix socket, so pi shows up as just another peer session.
 *
 * The reverse-engineered protocol is documented in the cc-pi repository.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
const PROBE_TIMEOUT_MS = 250;

type SessionRecord = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: string;
  messagingSocketPath: string;
  peerProtocol?: number;
  startedAt?: number;
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
    files = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(
        readFileSync(join(SESSIONS_DIR, file), "utf8"),
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
  if (trimmed.startsWith("uds:"))
    return { path: trimmed.slice(4), label: trimmed };
  if (trimmed.startsWith("/"))
    return { path: trimmed, label: `uds:${trimmed}` };

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
    const refs = candidates
      .map((record) => `${record.name} [${ref(record)}]`)
      .join(", ");
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
export default function ccPeer(pi: ExtensionAPI): void {
  pi.registerFlag("claude-peer", {
    description:
      "Make this pi session addressable from Claude Code peer messaging",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("cc-name", {
    description:
      "Peer name this pi session advertises when --claude-peer is enabled",
    type: "string",
  });

  const pid = process.pid;
  let socketPath = "";
  let recordPath = "";
  let selfAddress = "";
  let sessionId = "";
  let startedAt = 0;
  let server: Server | undefined;
  const connections = new Set<Socket>();
  let name =
    `pi-${basename(process.cwd()).replace(/[^A-Za-z0-9_-]/g, "-")}-${pid}`.slice(
      0,
      80,
    );
  let streaming = false;
  let toolsRegistered = false;

  const writeRecord = (status: string) => {
    if (!server) return;
    try {
      writeFileSync(
        recordPath,
        JSON.stringify({
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
          updatedAt: Date.now(),
          statusUpdatedAt: Date.now(),
        }),
      );
    } catch {
      // Losing a status update is not worth interrupting the session.
    }
  };

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
      ctx.ui.notify(
        `cc-peer: unparseable frame: ${line.slice(0, 120)}`,
        "warning",
      );
      return;
    }

    if (frame.action === "peer_message_status") {
      ctx.ui.notify(
        `cc-peer: delivery ${String(frame.status)} for ${String(frame.orig_msg_id ?? "")}`,
        "info",
      );
      return;
    }
    if (frame.type !== "user") return;

    const message = frame.message as { content?: unknown } | undefined;
    const content =
      typeof message?.content === "string" ? message.content : undefined;
    if (!content) return;

    // Claude wraps the body in <cross-session-message from="uds:..."> already, which
    // carries the reply address the send_message tool needs. Pass it through intact.
    deliver(content, ctx);
  };

  const startServer = (ctx: ExtensionContext) => {
    if (server) return;
    const socketDir = resolveSocketDir();
    socketPath = join(socketDir, `${pid}.sock`);
    recordPath = join(SESSIONS_DIR, `${pid}.json`);
    selfAddress = `uds:${socketPath}`;
    sessionId = randomUUID();
    startedAt = Date.now();

    const flagName = pi.getFlag("cc-name");
    if (typeof flagName === "string" && flagName.length > 0) {
      name = flagName.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
    }
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    try {
      rmSync(socketPath);
    } catch {
      // No stale socket to clear.
    }

    server = createServer({ allowHalfOpen: true }, (conn) => {
      connections.add(conn);
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString();
        let index: number;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim()) handleLine(line, ctx);
        }
      });
      conn.on("end", () => {
        if (buffer.trim()) handleLine(buffer, ctx);
        conn.end();
      });
      conn.on("close", () => connections.delete(conn));
      conn.on("error", () => connections.delete(conn));
    });
    server.on("error", (error) =>
      ctx.ui.notify(`cc-peer: server error: ${error.message}`, "error"),
    );
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      server?.unref();
      writeRecord("idle");
      ctx.ui.setStatus("cc-peer", `peer: ${name}`);
    });
  };

  const stopServer = () => {
    if (!server) return;
    for (const conn of connections) conn.destroy();
    connections.clear();
    server?.close();
    server = undefined;
    for (const path of [socketPath, recordPath]) {
      try {
        rmSync(path);
      } catch {
        // Already gone.
      }
    }
  };

  const registerTools = () => {
    if (toolsRegistered) return;
    toolsRegistered = true;

    pi.registerTool({
      name: "list_agents",
      label: "List agents",
      description:
        "List live peer sessions on this machine (Claude Code sessions and other cc-peer pi sessions). " +
        "Returns each peer's name, ref, status, and working directory. Use the name as the 'to' argument of send_message.",
      parameters: Type.Object({}),
      async execute() {
        const records = readRecords().filter((record) => record.pid !== pid);
        const live = await Promise.all(
          records.map(async (record) =>
            (await isLive(record.messagingSocketPath)) ? record : undefined,
          ),
        );
        const peers = live.filter(
          (record): record is SessionRecord => record !== undefined,
        );
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
    if (!pi.getFlag("claude-peer")) return;
    registerTools();
    startServer(ctx);
  });
  pi.on("session_shutdown", async () => stopServer());
  pi.on("agent_start", async () => {
    if (!server) return;
    streaming = true;
    writeRecord("busy");
  });
  pi.on("agent_settled", async () => {
    if (!server) return;
    streaming = false;
    writeRecord("idle");
  });
}
