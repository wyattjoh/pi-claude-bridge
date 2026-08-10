import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piBridge from "./index.ts";
import { nodePlatform } from "./platform.ts";

const MAX_PEER_FRAME_BYTES = 1_048_576;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type FlagDefinition = {
  default: unknown;
  description: string;
  type: string;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: unknown;
};

type ToolDefinition = {
  name: string;
  execute: (
    toolCallId: string | undefined,
    params: { to: string; message: string } | undefined,
  ) => Promise<ToolResult>;
};

type TestPaths = {
  root: string;
  sessionsDir: string;
  socketDir: string;
};

function createHarness(
  bridgeEnabled = false,
  onRegisterTool: (() => void) | undefined = undefined,
) {
  const flags = new Map<string, FlagDefinition>();
  const handlers = new Map<string, Handler>();
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const tools: ToolDefinition[] = [];
  const userMessages: Array<{ content: string; options: unknown }> = [];
  const userMessageListeners = new Set<(message: { content: string; options: unknown }) => void>();
  const pi = {
    getFlag(name: string) {
      return name === "bridge" && bridgeEnabled;
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerFlag(name: string, definition: FlagDefinition) {
      flags.set(name, definition);
    },
    registerTool(tool: ToolDefinition) {
      onRegisterTool?.();
      tools.push(tool);
    },
    sendUserMessage(content: string, options: unknown) {
      const message = { content, options };
      userMessages.push(message);
      for (const listener of userMessageListeners) listener(message);
      userMessageListeners.clear();
    },
  };
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.push({ key, value });
      },
    },
  };

  async function fire(event: string): Promise<void> {
    await handlers.get(event)?.({}, ctx);
  }

  function waitForUserMessage(): Promise<{ content: string; options: unknown }> {
    const existingMessage = userMessages[0];
    if (existingMessage) return Promise.resolve(existingMessage);
    return new Promise((resolve) => userMessageListeners.add(resolve));
  }

  return {
    fire,
    flags,
    notifications,
    pi,
    statuses,
    tools,
    userMessages,
    waitForUserMessage,
  };
}

function sendSocketBytes(socketPath: string, bytes: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath }, () => socket.end(bytes));
    socket.on("close", () => resolve());
    socket.on("error", reject);
  });
}

function listenUnixServer(socketPath: string): Promise<Server> {
  mkdirSync(join(socketPath, ".."), { recursive: true });
  const server = createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function listenPeerServer(
  socketPath: string,
): Promise<{ server: Server; waitForFrame: () => Promise<Record<string, unknown>> }> {
  mkdirSync(join(socketPath, ".."), { recursive: true });
  const frames: Record<string, unknown>[] = [];
  const listeners: Array<(frame: Record<string, unknown>) => void> = [];
  const server = createServer((socket) => {
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex === -1) return;
      const frame = JSON.parse(pending.slice(0, newlineIndex)) as Record<string, unknown>;
      frames.push(frame);
      listeners.shift()?.(frame);
    });
    socket.on("end", () => socket.end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    waitForFrame() {
      const existing = frames.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => listeners.push(resolve));
    },
  };
}

function writeOwnedRecord(recordPath: string, socketPath: string): string {
  const contents = JSON.stringify({
    messagingSocketPath: socketPath,
    _piBridge: { recordVersion: 1 },
  });
  writeFileSync(recordPath, contents);
  return contents;
}

function peerFrame(content: string): string {
  return JSON.stringify({ message: { content }, type: "user" });
}

function peerFrameWithByteLength(
  byteLength: number,
  fill: "ascii" | "multibyte",
): { content: string; frame: string } {
  const emptyFrame = peerFrame("");
  const contentBytes = byteLength - Buffer.byteLength(emptyFrame);
  if (contentBytes < 0) throw new Error("requested peer frame is too small");

  const content =
    fill === "ascii"
      ? "a".repeat(contentBytes)
      : `${"é".repeat(Math.floor(contentBytes / 2))}${contentBytes % 2 === 0 ? "" : "a"}`;
  const frame = peerFrame(content);
  if (Buffer.byteLength(frame) !== byteLength) {
    throw new Error(`could not construct a ${byteLength}-byte peer frame`);
  }
  return { content, frame };
}

function writePeer(
  socketPath: string,
  chunks: readonly (string | Uint8Array)[],
  endStream = true,
  pauseBetweenChunks = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    const socket = connect({ path: socketPath });
    const timeout = setTimeout(() => finish(new Error("peer connection did not close")), 2_000);
    const finish = (error: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else setImmediate(resolve);
    };

    socket.on("error", (error) => {
      if (!connected) finish(error);
    });
    socket.on("close", () => finish(undefined));
    socket.on("connect", () => {
      connected = true;
      void (async () => {
        for (const chunk of chunks) {
          if (socket.destroyed) break;
          await new Promise<void>((resolveWrite, rejectWrite) =>
            socket.write(chunk, (error) => (error ? rejectWrite(error) : resolveWrite())),
          );
          if (pauseBetweenChunks) await Bun.sleep(10);
        }
        if (endStream && !socket.destroyed) socket.end();
      })().catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  });
}

async function withTestPaths(run: (paths: TestPaths) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-claude-bridge-test-"));
  const previousEnvironment = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  };
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    HOME: root,
    XDG_RUNTIME_DIR: join(root, "runtime"),
  });

  try {
    await run({
      root,
      sessionsDir: join(root, ".claude", "sessions"),
      socketDir: join(root, "runtime", "cc-socks"),
    });
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { force: true, recursive: true });
  }
}

describe("pi-claude-bridge opt-in", () => {
  test.serial("stays inactive unless --bridge is provided", async () => {
    await withTestPaths(async ({ root }) => {
      const harness = createHarness();
      piBridge(harness.pi as never);

      expect([...harness.flags]).toEqual([
        [
          "bridge",
          {
            default: false,
            description: "Make this pi session addressable from Claude Code peer messaging",
            type: "boolean",
          },
        ],
      ]);
      expect(harness.tools).toEqual([]);

      await harness.fire("session_start");
      await harness.fire("agent_start");
      await harness.fire("agent_settled");
      await harness.fire("session_shutdown");

      expect(harness.tools).toEqual([]);
      expect(existsSync(join(root, ".claude"))).toBe(false);
      expect(existsSync(join(root, "runtime"))).toBe(false);
    });
  });

  test.serial("does not reap marked records while the bridge is disabled", async () => {
    await withTestPaths(async ({ root, sessionsDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      const recordPath = join(sessionsDir, "stale.json");
      writeOwnedRecord(recordPath, join(root, "missing.sock"));
      const harness = createHarness();
      piBridge(harness.pi as never);

      await harness.fire("session_start");

      expect(existsSync(recordPath)).toBe(true);
      expect(harness.tools).toEqual([]);
    });
  });

  test.serial("publishes a secured idle peer before exposing tools", async () => {
    await withTestPaths(async ({ sessionsDir, socketDir }) => {
      const socketPath = join(socketDir, `${process.pid}.sock`);
      const recordPath = join(sessionsDir, `${process.pid}.json`);
      const harness = createHarness(true, () => {
        expect(existsSync(socketPath)).toBe(true);
        expect(existsSync(recordPath)).toBe(true);
      });
      piBridge(harness.pi as never);

      expect(harness.tools).toEqual([]);
      await harness.fire("session_start");
      expect(harness.notifications).toEqual([]);

      const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;

      expect(harness.tools.map((tool) => tool.name)).toEqual(["list_agents", "send_message"]);
      expect(statSync(sessionsDir).mode & 0o777).toBe(0o700);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(statSync(recordPath).mode & 0o777).toBe(0o600);
      expect(record).toMatchObject({
        pid: process.pid,
        cwd: process.cwd(),
        peerProtocol: 1,
        kind: "interactive",
        entrypoint: "cli",
        messagingSocketPath: socketPath,
        nameSource: "derived",
        status: "idle",
        _piBridge: { recordVersion: 1 },
      });
      expect(typeof record.sessionId).toBe("string");
      expect(typeof record.startedAt).toBe("number");
      expect(typeof record.procStart).toBe("string");
      expect(typeof record.version).toBe("string");
      expect(typeof record.name).toBe("string");
      expect(typeof record.updatedAt).toBe("number");
      expect(typeof record.statusUpdatedAt).toBe("number");
      expect(harness.statuses).toEqual([
        { key: "pi-claude-bridge", value: `peer: ${String(record.name)}` },
      ]);

      await harness.fire("session_shutdown");
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(recordPath)).toBe(false);
    });
  });

  test.serial("does not acquire a second bridge for duplicate start events", async () => {
    await withTestPaths(async ({ sessionsDir }) => {
      const harness = createHarness(true);
      piBridge(harness.pi as never);

      await harness.fire("session_start");
      await harness.fire("session_start");

      expect(harness.tools.map((tool) => tool.name)).toEqual(["list_agents", "send_message"]);
      expect(harness.statuses).toHaveLength(1);
      expect(existsSync(join(sessionsDir, `${process.pid}.json`))).toBe(true);

      await harness.fire("session_shutdown");
      expect(existsSync(join(sessionsDir, `${process.pid}.json`))).toBe(false);
    });
  });

  test.serial(
    "supports discovery, bidirectional messaging, statuses, and shutdown over real sockets",
    async () => {
      await withTestPaths(async ({ root, sessionsDir }) => {
        mkdirSync(sessionsDir, { recursive: true });
        const peerDirectory = join(root, "peer-sockets");
        const nativeSocketPath = join(peerDirectory, "native.sock");
        const markedSocketPath = join(peerDirectory, "marked.sock");
        const nativePeer = await listenPeerServer(nativeSocketPath);
        const markedPeer = await listenPeerServer(markedSocketPath);
        const nativeRecordPath = join(sessionsDir, "native.json");
        const markedRecordPath = join(sessionsDir, "marked.json");
        writeFileSync(
          nativeRecordPath,
          JSON.stringify({
            pid: process.pid + 1,
            sessionId: "a1b2c3d4-native",
            cwd: join(root, "native-project"),
            name: "native-peer",
            status: "idle",
            messagingSocketPath: nativeSocketPath,
          }),
        );
        writeFileSync(
          markedRecordPath,
          JSON.stringify({
            pid: process.pid + 2,
            sessionId: "d4c3b2a1-marked",
            cwd: join(root, "marked-project"),
            name: "marked-peer",
            status: "busy",
            messagingSocketPath: markedSocketPath,
            _piBridge: { recordVersion: 1 },
          }),
        );

        try {
          const harness = createHarness(true);
          piBridge(harness.pi as never);
          await harness.fire("session_start");

          const ownRecordPath = join(sessionsDir, `${process.pid}.json`);
          const ownRecord = JSON.parse(readFileSync(ownRecordPath, "utf8")) as {
            messagingSocketPath: string;
            status: string;
          };
          const listAgents = harness.tools.find((tool) => tool.name === "list_agents");
          const listing = await listAgents?.execute(undefined, undefined);
          expect(listing?.content[0]?.text).toContain("native-peer [a1b2c3]");
          expect(listing?.content[0]?.text).toContain("marked-peer [d4c3b2]");

          const sendMessage = harness.tools.find((tool) => tool.name === "send_message");
          const nativeFramePromise = nativePeer.waitForFrame();
          await sendMessage?.execute("native-call", {
            to: "native-peer",
            message: "hello native",
          });
          const nativeFrame = await nativeFramePromise;
          expect(nativeFrame.type).toBe("user");
          expect(nativeFrame.message).toMatchObject({
            content: expect.stringContaining("hello native"),
            role: "user",
          });

          const markedFramePromise = markedPeer.waitForFrame();
          await sendMessage?.execute("marked-call", {
            to: "marked-peer [d4c3b2]",
            message: "hello marked",
          });
          expect(await markedFramePromise).toMatchObject({ type: "user" });

          await harness.fire("agent_start");
          expect(JSON.parse(readFileSync(ownRecordPath, "utf8")).status).toBe("busy");
          const busyMessage = harness.waitForUserMessage();
          await sendSocketBytes(
            ownRecord.messagingSocketPath,
            `${peerFrame("incoming while busy")}\n`,
          );
          expect(await busyMessage).toEqual({
            content: "incoming while busy",
            options: { deliverAs: "followUp" },
          });

          harness.userMessages.length = 0;
          await harness.fire("agent_settled");
          expect(JSON.parse(readFileSync(ownRecordPath, "utf8")).status).toBe("idle");
          const idleMessage = harness.waitForUserMessage();
          await sendSocketBytes(
            ownRecord.messagingSocketPath,
            `${peerFrame("incoming while idle")}\n`,
          );
          expect(await idleMessage).toEqual({
            content: "incoming while idle",
            options: undefined,
          });

          await harness.fire("session_shutdown");
          await harness.fire("session_shutdown");
          expect(existsSync(ownRecordPath)).toBe(false);
          expect(existsSync(ownRecord.messagingSocketPath)).toBe(false);
          expect(existsSync(nativeRecordPath)).toBe(true);
          expect(existsSync(markedRecordPath)).toBe(true);
        } finally {
          await closeServer(nativePeer.server);
          await closeServer(markedPeer.server);
        }
      });
    },
  );

  test.serial("preserves an identical replacement at its published record path", async () => {
    await withTestPaths(async ({ sessionsDir }) => {
      const harness = createHarness(true);
      piBridge(harness.pi as never);
      await harness.fire("session_start");

      const recordPath = join(sessionsDir, `${process.pid}.json`);
      const originalContents = readFileSync(recordPath, "utf8");
      rmSync(recordPath);
      writeFileSync(recordPath, originalContents, { mode: 0o600 });
      const replacementIdentity = statSync(recordPath);

      await harness.fire("session_shutdown");

      expect(readFileSync(recordPath, "utf8")).toBe(originalContents);
      expect(statSync(recordPath)).toMatchObject({
        dev: replacementIdentity.dev,
        ino: replacementIdentity.ino,
      });
    });
  });

  test.serial("preserves a replacement raced after a status rewrite", async () => {
    await withTestPaths(async ({ sessionsDir }) => {
      const harness = createHarness(true);
      piBridge(harness.pi as never, {
        connectSocket: undefined,
        platform: {
          ...nodePlatform,
          rename(temporaryPath, recordPath) {
            nodePlatform.rename(temporaryPath, recordPath);
            const replacement = readFileSync(recordPath, "utf8");
            rmSync(recordPath);
            writeFileSync(recordPath, replacement, { mode: 0o600 });
          },
        },
      });
      await harness.fire("session_start");
      const recordPath = join(sessionsDir, `${process.pid}.json`);

      await harness.fire("agent_start");
      const replacementContents = readFileSync(recordPath, "utf8");
      const replacementIdentity = statSync(recordPath);
      await harness.fire("session_shutdown");

      expect(readFileSync(recordPath, "utf8")).toBe(replacementContents);
      expect(statSync(recordPath)).toMatchObject({
        dev: replacementIdentity.dev,
        ino: replacementIdentity.ino,
      });
    });
  });

  test.serial("preserves a live replacement at its published socket path", async () => {
    await withTestPaths(async ({ sessionsDir }) => {
      const harness = createHarness(true);
      piBridge(harness.pi as never);
      await harness.fire("session_start");

      const record = JSON.parse(readFileSync(join(sessionsDir, `${process.pid}.json`), "utf8")) as {
        messagingSocketPath: string;
      };
      rmSync(record.messagingSocketPath);
      const replacementServer = await listenUnixServer(record.messagingSocketPath);
      const replacementIdentity = statSync(record.messagingSocketPath);

      try {
        await harness.fire("session_shutdown");

        const restoredIdentity = statSync(record.messagingSocketPath);
        expect(restoredIdentity.isSocket()).toBe(true);
        expect(restoredIdentity).toMatchObject({
          dev: replacementIdentity.dev,
          ino: replacementIdentity.ino,
        });
        await sendSocketBytes(record.messagingSocketPath, "");
      } finally {
        await closeServer(replacementServer);
      }
    });
  });

  test.serial("reaps an unchanged marked record before selecting a socket directory", async () => {
    await withTestPaths(async ({ sessionsDir, socketDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      const staleRecordPath = join(sessionsDir, "stale.json");
      writeOwnedRecord(staleRecordPath, join(sessionsDir, "missing.sock"));
      const harness = createHarness(true, () => {
        expect(existsSync(staleRecordPath)).toBe(false);
      });
      piBridge(harness.pi as never);

      await harness.fire("session_start");

      const ownRecord = JSON.parse(
        readFileSync(join(sessionsDir, `${process.pid}.json`), "utf8"),
      ) as { messagingSocketPath: string };
      expect(existsSync(staleRecordPath)).toBe(false);
      expect(ownRecord.messagingSocketPath).toBe(join(socketDir, `${process.pid}.sock`));
      await harness.fire("session_shutdown");
    });
  });

  test.serial("removes only the stale record and never its advertised path", async () => {
    await withTestPaths(async ({ root, sessionsDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      const advertisedPath = join(root, "unrelated-resource");
      writeFileSync(advertisedPath, "keep me");
      const recordPath = join(sessionsDir, "stale.json");
      writeOwnedRecord(recordPath, advertisedPath);
      const harness = createHarness(true);
      piBridge(harness.pi as never, {
        connectSocket() {
          const socket = new Socket();
          setImmediate(() =>
            socket.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })),
          );
          return socket;
        },
        platform: undefined,
      });

      await harness.fire("session_start");

      expect(existsSync(recordPath)).toBe(false);
      expect(readFileSync(advertisedPath, "utf8")).toBe("keep me");
      await harness.fire("session_shutdown");
    });
  });

  test.serial("retains a marked record whose socket is reachable", async () => {
    await withTestPaths(async ({ root, sessionsDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      const liveSocketPath = join(root, "probe", "live.sock");
      const liveRecordPath = join(sessionsDir, "live.json");
      const liveServer = await listenUnixServer(liveSocketPath);
      writeOwnedRecord(liveRecordPath, liveSocketPath);

      try {
        const harness = createHarness(true);
        piBridge(harness.pi as never);
        await harness.fire("session_start");

        expect(existsSync(liveRecordPath)).toBe(true);
        await harness.fire("session_shutdown");
      } finally {
        await closeServer(liveServer);
      }
    });
  });

  test.serial("retains a marked record when its socket probe times out", async () => {
    await withTestPaths(async ({ root, sessionsDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      const recordPath = join(sessionsDir, "indeterminate.json");
      writeOwnedRecord(recordPath, join(root, "indeterminate.sock"));
      const harness = createHarness(true);
      piBridge(harness.pi as never, {
        connectSocket() {
          const socket = new Socket();
          setImmediate(() => socket.emit("timeout"));
          return socket;
        },
        platform: undefined,
      });

      await harness.fire("session_start");

      expect(existsSync(recordPath)).toBe(true);
      await harness.fire("session_shutdown");
    });
  });

  test.serial("retains records and entries that cannot prove bridge ownership", async () => {
    await withTestPaths(async ({ root, sessionsDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      const missingSocketPath = join(root, "missing.sock");
      const retainedPaths = [
        join(sessionsDir, "native.json"),
        join(sessionsDir, "unmarked.json"),
        join(sessionsDir, "malformed.json"),
        join(sessionsDir, "array.json"),
        join(sessionsDir, "unknown-version.json"),
        join(sessionsDir, "extended-marker.json"),
        join(sessionsDir, "invalid-path.json"),
        join(sessionsDir, "symlink.json"),
        join(sessionsDir, "directory.json"),
        join(sessionsDir, "special.json"),
      ];

      writeFileSync(
        retainedPaths[0]!,
        JSON.stringify({
          pid: 123,
          sessionId: "native",
          messagingSocketPath: missingSocketPath,
        }),
      );
      writeFileSync(retainedPaths[1]!, JSON.stringify({ messagingSocketPath: missingSocketPath }));
      writeFileSync(retainedPaths[2]!, "{");
      writeFileSync(
        retainedPaths[3]!,
        JSON.stringify([
          { messagingSocketPath: missingSocketPath, _piBridge: { recordVersion: 1 } },
        ]),
      );
      writeFileSync(
        retainedPaths[4]!,
        JSON.stringify({
          messagingSocketPath: missingSocketPath,
          _piBridge: { recordVersion: 2 },
        }),
      );
      writeFileSync(
        retainedPaths[5]!,
        JSON.stringify({
          messagingSocketPath: missingSocketPath,
          _piBridge: { recordVersion: 1, extra: true },
        }),
      );
      writeFileSync(
        retainedPaths[6]!,
        JSON.stringify({
          messagingSocketPath: "relative.sock",
          _piBridge: { recordVersion: 1 },
        }),
      );
      const symlinkTarget = join(root, "symlink-target.json");
      writeOwnedRecord(symlinkTarget, missingSocketPath);
      symlinkSync(symlinkTarget, retainedPaths[7]!);
      mkdirSync(retainedPaths[8]!);
      const specialServer = await listenUnixServer(retainedPaths[9]!);

      try {
        const harness = createHarness(true);
        piBridge(harness.pi as never);
        await harness.fire("session_start");

        expect(retainedPaths.map((path) => existsSync(path))).toEqual(
          retainedPaths.map(() => true),
        );
        expect(readFileSync(symlinkTarget, "utf8")).toContain('"recordVersion":1');
        await harness.fire("session_shutdown");
      } finally {
        await closeServer(specialServer);
      }
    });
  });

  test.serial("retains a marked record changed while its socket is probed", async () => {
    await withTestPaths(async ({ root, sessionsDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      const recordPath = join(sessionsDir, "changed.json");
      writeOwnedRecord(recordPath, join(root, "missing.sock"));
      const harness = createHarness(true);
      piBridge(harness.pi as never);

      const startup = harness.fire("session_start");
      writeFileSync(
        recordPath,
        JSON.stringify({
          messagingSocketPath: join(root, "missing.sock"),
          changed: true,
          _piBridge: { recordVersion: 1 },
        }),
      );
      await startup;

      expect(readFileSync(recordPath, "utf8")).toContain('"changed":true');
      await harness.fire("session_shutdown");
    });
  });

  test.serial("retains a marked record replaced while its socket is probed", async () => {
    await withTestPaths(async ({ root, sessionsDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      const recordPath = join(sessionsDir, "replaced.json");
      const originalContents = writeOwnedRecord(recordPath, join(root, "missing.sock"));
      const harness = createHarness(true);
      piBridge(harness.pi as never);

      const startup = harness.fire("session_start");
      rmSync(recordPath);
      writeFileSync(recordPath, originalContents);
      await startup;

      expect(readFileSync(recordPath, "utf8")).toBe(originalContents);
      await harness.fire("session_shutdown");
    });
  });

  test.serial("keeps peer listing observational", async () => {
    await withTestPaths(async ({ root, sessionsDir }) => {
      const harness = createHarness(true);
      piBridge(harness.pi as never);
      await harness.fire("session_start");
      const recordPath = join(sessionsDir, "stale-after-startup.json");
      writeOwnedRecord(recordPath, join(root, "missing.sock"));

      const listAgents = harness.tools.find((tool) => tool.name === "list_agents");
      await listAgents?.execute(undefined, undefined);

      expect(existsSync(recordPath)).toBe(true);
      await harness.fire("session_shutdown");
    });
  });

  test.serial("does not alter an existing sessions directory permission", async () => {
    await withTestPaths(async ({ sessionsDir }) => {
      mkdirSync(sessionsDir, { recursive: true });
      chmodSync(sessionsDir, 0o755);
      const harness = createHarness(true);
      piBridge(harness.pi as never);

      await harness.fire("session_start");

      expect(statSync(sessionsDir).mode & 0o777).toBe(0o755);
      await harness.fire("session_shutdown");
    });
  });

  test.serial("rolls back a controlled platform startup failure", async () => {
    await withTestPaths(async ({ root }) => {
      const harness = createHarness(true);
      piBridge(harness.pi as never, {
        connectSocket: undefined,
        platform: {
          ...nodePlatform,
          async listenServer() {
            throw new Error("controlled server failure");
          },
        },
      });

      await harness.fire("session_start");

      expect(harness.tools).toEqual([]);
      expect(harness.statuses).toEqual([]);
      expect(harness.notifications).toEqual([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("controlled server failure"),
        }),
      ]);
      expect(existsSync(join(root, ".claude"))).toBe(false);
      expect(existsSync(join(root, "runtime"))).toBe(false);
    });
  });

  test.serial("renders injected outbound socket errors as rejected tool calls", async () => {
    await withTestPaths(async ({ root }) => {
      const harness = createHarness(true);
      piBridge(harness.pi as never, {
        connectSocket() {
          const socket = new Socket();
          setImmediate(() => socket.emit("error", new Error("controlled transport failure")));
          return socket;
        },
        platform: undefined,
      });
      await harness.fire("session_start");

      const sendMessage = harness.tools.find((tool) => tool.name === "send_message");
      await expect(
        sendMessage?.execute("outbound-failure", {
          to: `uds:${join(root, "missing.sock")}`,
          message: "hello",
        }),
      ).rejects.toThrow("controlled transport failure");

      await harness.fire("session_shutdown");
    });
  });

  test.serial("visibly disables the bridge when the sessions path is not a directory", async () => {
    await withTestPaths(async ({ sessionsDir }) => {
      mkdirSync(join(sessionsDir, ".."), { recursive: true });
      writeFileSync(sessionsDir, "not a directory");
      const harness = createHarness(true);
      piBridge(harness.pi as never);

      await harness.fire("session_start");
      await harness.fire("agent_start");
      await harness.fire("agent_settled");
      await harness.fire("session_shutdown");

      expect(harness.tools).toEqual([]);
      expect(harness.statuses).toEqual([]);
      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0]).toMatchObject({ level: "error" });
      expect(harness.notifications[0]?.message).toContain("is not a directory");
      expect(readFileSync(sessionsDir, "utf8")).toBe("not a directory");
    });
  });

  test.serial("rolls back created directories without removing a conflicting socket", async () => {
    await withTestPaths(async ({ root, sessionsDir, socketDir }) => {
      mkdirSync(socketDir, { mode: 0o700, recursive: true });
      const socketPath = join(socketDir, `${process.pid}.sock`);
      writeFileSync(socketPath, "pre-existing");
      const harness = createHarness(true);
      piBridge(harness.pi as never);

      await harness.fire("session_start");

      expect(harness.tools).toEqual([]);
      expect(harness.statuses).toEqual([]);
      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0]).toMatchObject({ level: "error" });
      expect(readFileSync(socketPath, "utf8")).toBe("pre-existing");
      expect(existsSync(sessionsDir)).toBe(false);
      expect(existsSync(join(root, ".claude"))).toBe(false);
    });
  });

  test.serial("rolls back its socket without replacing an existing session record", async () => {
    await withTestPaths(async ({ root, sessionsDir, socketDir }) => {
      mkdirSync(sessionsDir, { mode: 0o700, recursive: true });
      const recordPath = join(sessionsDir, `${process.pid}.json`);
      writeFileSync(recordPath, "pre-existing", { mode: 0o600 });
      const harness = createHarness(true);
      piBridge(harness.pi as never);

      await harness.fire("session_start");

      expect(harness.tools).toEqual([]);
      expect(harness.statuses).toEqual([]);
      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0]).toMatchObject({ level: "error" });
      expect(readFileSync(recordPath, "utf8")).toBe("pre-existing");
      expect(existsSync(join(socketDir, `${process.pid}.sock`))).toBe(false);
      expect(existsSync(join(root, "runtime"))).toBe(false);
    });
  });

  test.serial(
    "preserves record identity across status updates and warns once on degradation",
    async () => {
      await withTestPaths(async ({ sessionsDir, socketDir }) => {
        const harness = createHarness(true);
        piBridge(harness.pi as never);
        await harness.fire("session_start");

        const socketPath = join(socketDir, `${process.pid}.sock`);
        const recordPath = join(sessionsDir, `${process.pid}.json`);
        const idleRecord = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;

        await harness.fire("agent_start");
        const busyRecord = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
        expect(busyRecord.status).toBe("busy");
        for (const field of [
          "pid",
          "sessionId",
          "cwd",
          "startedAt",
          "procStart",
          "version",
          "peerProtocol",
          "kind",
          "entrypoint",
          "messagingSocketPath",
          "name",
          "nameSource",
          "_piBridge",
        ]) {
          expect(busyRecord[field]).toEqual(idleRecord[field]);
        }
        expect(statSync(recordPath).mode & 0o777).toBe(0o600);

        await harness.fire("agent_settled");
        const settledRecord = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
          string,
          unknown
        >;
        expect(settledRecord.status).toBe("idle");
        expect(settledRecord._piBridge).toEqual({ recordVersion: 1 });

        rmSync(recordPath);
        mkdirSync(recordPath);
        await harness.fire("agent_start");
        await harness.fire("agent_settled");
        expect(harness.notifications.filter(({ level }) => level === "warning")).toHaveLength(1);

        const receivedMessage = harness.waitForUserMessage();
        await sendSocketBytes(
          socketPath,
          `${JSON.stringify({
            msgV: 1,
            type: "user",
            message: { role: "user", content: "still reachable" },
          })}\n`,
        );
        expect(await receivedMessage).toEqual({ content: "still reachable", options: undefined });
        expect(existsSync(socketPath)).toBe(true);

        await harness.fire("session_shutdown");
        expect(existsSync(socketPath)).toBe(false);
      });
    },
  );
});

describe("peer frame byte stream", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-claude-bridge-frame-test-"));
  const sessionsDir = join(root, ".claude", "sessions");
  const previousEnvironment = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  };
  const harness = createHarness(true);
  let socketPath = "";

  beforeAll(async () => {
    Object.assign(process.env, {
      CLAUDE_CONFIG_DIR: join(root, ".claude"),
      HOME: root,
      XDG_RUNTIME_DIR: join(root, "runtime"),
    });
    piBridge(harness.pi as never);
    await harness.fire("session_start");
    const record = JSON.parse(readFileSync(join(sessionsDir, `${process.pid}.json`), "utf8")) as {
      messagingSocketPath: string;
    };
    socketPath = record.messagingSocketPath;
  });

  beforeEach(() => {
    harness.userMessages.length = 0;
    harness.notifications.length = 0;
  });

  test.serial("ignores empty frames and delivers an ordinary frame", async () => {
    await writePeer(socketPath, [`\n \n${peerFrame("ordinary")}\n`]);

    expect(harness.userMessages.map(({ content }) => content)).toEqual(["ordinary"]);
    expect(harness.notifications.filter(({ level }) => level === "warning")).toEqual([]);
  });

  test.serial("accepts a frame exactly at the byte limit", async () => {
    const { content, frame } = peerFrameWithByteLength(MAX_PEER_FRAME_BYTES, "ascii");

    await writePeer(socketPath, [`${frame}\n`]);

    expect(Buffer.byteLength(frame)).toBe(MAX_PEER_FRAME_BYTES);
    expect(harness.userMessages).toHaveLength(1);
    expect(harness.userMessages[0]?.content.length).toBe(content.length);
    expect(harness.notifications.filter(({ level }) => level === "warning")).toEqual([]);
  });

  test.serial("rejects a complete multibyte frame one byte over the byte limit", async () => {
    const { frame } = peerFrameWithByteLength(MAX_PEER_FRAME_BYTES + 1, "multibyte");

    await writePeer(socketPath, [`${frame}\n`]);

    expect(frame.length).toBeLessThan(MAX_PEER_FRAME_BYTES);
    expect(Buffer.byteLength(frame)).toBe(MAX_PEER_FRAME_BYTES + 1);
    expect(harness.userMessages).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        level: "warning",
        message: `pi-claude-bridge: peer frame exceeds ${MAX_PEER_FRAME_BYTES} byte limit`,
      },
    ]);
  });

  test.serial("processes multiple frames from one chunk independently", async () => {
    await writePeer(socketPath, [
      `${peerFrame("first")}\n${peerFrame("second")}\n${peerFrame("third")}\n`,
    ]);

    expect(harness.userMessages.map(({ content }) => content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test.serial("reconstructs a frame with a delimiter split across chunks", async () => {
    await writePeer(socketPath, [peerFrame("split delimiter"), "\n"], true, true);

    expect(harness.userMessages.map(({ content }) => content)).toEqual(["split delimiter"]);
  });

  test.serial("reconstructs a multibyte UTF-8 character split across chunks", async () => {
    const encoded = Buffer.from(`${peerFrame("hello 🌍")}\n`);
    const characterIndex = encoded.indexOf(Buffer.from("🌍"));

    await writePeer(
      socketPath,
      [encoded.subarray(0, characterIndex + 2), encoded.subarray(characterIndex + 2)],
      true,
      true,
    );

    expect(harness.userMessages.map(({ content }) => content)).toEqual(["hello 🌍"]);
  });

  test.serial("processes a bounded final frame at end-of-stream", async () => {
    await writePeer(socketPath, [peerFrame("final without delimiter")]);

    expect(harness.userMessages.map(({ content }) => content)).toEqual(["final without delimiter"]);
  });

  test.serial("retains the existing warning for malformed bounded JSON", async () => {
    await writePeer(socketPath, ["not-json\n"]);

    expect(harness.userMessages).toEqual([]);
    expect(harness.notifications).toEqual([
      { level: "warning", message: "pi-claude-bridge: unparseable frame: not-json" },
    ]);
  });

  test.serial("rejects oversized unterminated input without stopping the server", async () => {
    await writePeer(socketPath, [Buffer.alloc(MAX_PEER_FRAME_BYTES + 1, 0x61)], false);

    expect(harness.userMessages).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        level: "warning",
        message: `pi-claude-bridge: peer frame exceeds ${MAX_PEER_FRAME_BYTES} byte limit`,
      },
    ]);
    expect(harness.notifications[0]?.message.length).toBeLessThan(200);

    harness.notifications.length = 0;
    await writePeer(socketPath, [`${peerFrame("still available")}\n`]);

    expect(harness.userMessages.map(({ content }) => content)).toEqual(["still available"]);
    expect(harness.notifications.filter(({ level }) => level === "warning")).toEqual([]);
  });

  afterAll(async () => {
    await harness.fire("session_shutdown");
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { force: true, recursive: true });
  });
});
