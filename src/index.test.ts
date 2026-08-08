import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piBridge from "./index.ts";

const MAX_PEER_FRAME_BYTES = 1_048_576;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type FlagDefinition = {
  default: unknown;
  description: string;
  type: string;
};

type ToolDefinition = {
  name: string;
  execute: (...args: never[]) => Promise<unknown>;
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
  const root = mkdtempSync(join(tmpdir(), "pi-bridge-test-"));
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

describe("pi-bridge opt-in", () => {
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
        { key: "pi-bridge", value: `peer: ${String(record.name)}` },
      ]);

      await harness.fire("session_shutdown");
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(recordPath)).toBe(false);
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
  const root = mkdtempSync(join(tmpdir(), "pi-bridge-frame-test-"));
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
        message: `pi-bridge: peer frame exceeds ${MAX_PEER_FRAME_BYTES} byte limit`,
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
      { level: "warning", message: "pi-bridge: unparseable frame: not-json" },
    ]);
  });

  test.serial("rejects oversized unterminated input without stopping the server", async () => {
    await writePeer(socketPath, [Buffer.alloc(MAX_PEER_FRAME_BYTES + 1, 0x61)], false);

    expect(harness.userMessages).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        level: "warning",
        message: `pi-bridge: peer frame exceeds ${MAX_PEER_FRAME_BYTES} byte limit`,
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
