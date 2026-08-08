import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MAX_PEER_FRAME_BYTES = 1_048_576;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
const testRoot = mkdtempSync(join(tmpdir(), "pi-bridge-test-"));
const sessionsDir = join(homedir(), ".claude", "sessions");
process.env.XDG_RUNTIME_DIR = join(testRoot, "runtime");

const { default: piBridge } = await import("./index.ts");

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type FlagDefinition = {
  default?: unknown;
  description: string;
  type: string;
};

function createHarness(bridge = false) {
  const flags = new Map<string, FlagDefinition>();
  const handlers = new Map<string, Handler>();
  const messages: string[] = [];
  const notifications: { level: string; message: string }[] = [];
  const tools: string[] = [];
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const pi = {
    getFlag(name: string) {
      return name === "bridge" ? bridge : undefined;
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerFlag(name: string, definition: FlagDefinition) {
      flags.set(name, definition);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    sendUserMessage(content: string) {
      messages.push(content);
    },
  };
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ level, message });
      },
      setStatus() {
        markReady();
      },
    },
  };

  return { ctx, flags, handlers, messages, notifications, pi, ready, tools };
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

describe("pi-bridge opt-in", () => {
  test("stays inactive unless --bridge is provided", async () => {
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

    await harness.handlers.get("session_start")?.({}, {});
    await harness.handlers.get("agent_start")?.({}, {});
    await harness.handlers.get("agent_settled")?.({}, {});
    await harness.handlers.get("session_shutdown")?.({}, {});

    expect(harness.tools).toEqual([]);
  });
});

describe("peer frame byte stream", () => {
  const harness = createHarness(true);
  let socketPath = "";

  beforeAll(async () => {
    mkdirSync(sessionsDir, { recursive: true });
    piBridge(harness.pi as never);
    await harness.handlers.get("session_start")?.({}, harness.ctx);
    await harness.ready;
    const record = JSON.parse(readFileSync(join(sessionsDir, `${process.pid}.json`), "utf8")) as {
      messagingSocketPath: string;
    };
    socketPath = record.messagingSocketPath;
  });

  beforeEach(() => {
    harness.messages.length = 0;
    harness.notifications.length = 0;
  });

  test("ignores empty frames and delivers an ordinary frame", async () => {
    await writePeer(socketPath, [`\n \n${peerFrame("ordinary")}\n`]);

    expect(harness.messages).toEqual(["ordinary"]);
    expect(harness.notifications.filter(({ level }) => level === "warning")).toEqual([]);
  });

  test("accepts a frame exactly at the byte limit", async () => {
    const { content, frame } = peerFrameWithByteLength(MAX_PEER_FRAME_BYTES, "ascii");

    await writePeer(socketPath, [`${frame}\n`]);

    expect(Buffer.byteLength(frame)).toBe(MAX_PEER_FRAME_BYTES);
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]?.length).toBe(content.length);
    expect(harness.notifications.filter(({ level }) => level === "warning")).toEqual([]);
  });

  test("rejects a complete multibyte frame one byte over the byte limit", async () => {
    const { frame } = peerFrameWithByteLength(MAX_PEER_FRAME_BYTES + 1, "multibyte");

    await writePeer(socketPath, [`${frame}\n`]);

    expect(frame.length).toBeLessThan(MAX_PEER_FRAME_BYTES);
    expect(Buffer.byteLength(frame)).toBe(MAX_PEER_FRAME_BYTES + 1);
    expect(harness.messages).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        level: "warning",
        message: `pi-bridge: peer frame exceeds ${MAX_PEER_FRAME_BYTES} byte limit`,
      },
    ]);
  });

  test("processes multiple frames from one chunk independently", async () => {
    await writePeer(socketPath, [
      `${peerFrame("first")}\n${peerFrame("second")}\n${peerFrame("third")}\n`,
    ]);

    expect(harness.messages).toEqual(["first", "second", "third"]);
  });

  test("reconstructs a frame with a delimiter split across chunks", async () => {
    await writePeer(socketPath, [peerFrame("split delimiter"), "\n"], true, true);

    expect(harness.messages).toEqual(["split delimiter"]);
  });

  test("reconstructs a multibyte UTF-8 character split across chunks", async () => {
    const encoded = Buffer.from(`${peerFrame("hello 🌍")}\n`);
    const characterIndex = encoded.indexOf(Buffer.from("🌍"));

    await writePeer(
      socketPath,
      [encoded.subarray(0, characterIndex + 2), encoded.subarray(characterIndex + 2)],
      true,
      true,
    );

    expect(harness.messages).toEqual(["hello 🌍"]);
  });

  test("processes a bounded final frame at end-of-stream", async () => {
    await writePeer(socketPath, [peerFrame("final without delimiter")]);

    expect(harness.messages).toEqual(["final without delimiter"]);
  });

  test("retains the existing warning for malformed bounded JSON", async () => {
    await writePeer(socketPath, ["not-json\n"]);

    expect(harness.messages).toEqual([]);
    expect(harness.notifications).toEqual([
      { level: "warning", message: "pi-bridge: unparseable frame: not-json" },
    ]);
  });

  test("rejects oversized unterminated input without stopping the server", async () => {
    await writePeer(socketPath, [Buffer.alloc(MAX_PEER_FRAME_BYTES + 1, 0x61)], false);

    expect(harness.messages).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        level: "warning",
        message: `pi-bridge: peer frame exceeds ${MAX_PEER_FRAME_BYTES} byte limit`,
      },
    ]);
    expect(harness.notifications[0]?.message.length).toBeLessThan(200);

    harness.notifications.length = 0;
    await writePeer(socketPath, [`${peerFrame("still available")}\n`]);

    expect(harness.messages).toEqual(["still available"]);
    expect(harness.notifications.filter(({ level }) => level === "warning")).toEqual([]);
  });

  afterAll(async () => {
    await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
    rmSync(testRoot, { force: true, recursive: true });
    if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  });
});
