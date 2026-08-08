import { Context, Data, Effect, Layer, Scope } from "effect";
import { type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { NodePlatform } from "./platform.ts";

const PROBE_TIMEOUT_MS = 250;
const MAX_PEER_FRAME_BYTES = 1_048_576;

type SessionRecord = {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly name: string;
  readonly status: string;
  readonly messagingSocketPath: string;
  readonly peerProtocol: number | undefined;
  readonly startedAt: number | undefined;
};

type PeerFrame = {
  readonly msgV: number;
  readonly msg_id: string;
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly priority: "next";
  readonly from: string;
};

type SocketProbeOutcome = "reachable" | "unreachable" | "indeterminate";

type PathIdentity = {
  readonly device: number;
  readonly inode: number;
};

type RecordIdentity = PathIdentity & {
  readonly size: number;
  readonly modifiedAt: number;
  readonly changedAt: number;
};

type PreservedSocketReplacement = {
  readonly path: string;
  readonly identity: PathIdentity;
};

type OwnedRecordCandidate = {
  readonly path: string;
  readonly contents: string;
  readonly socketPath: string;
  readonly identity: RecordIdentity;
};

type BridgeHost = {
  readonly deliver: (content: string) => void;
  readonly notify: (message: string, level: "error" | "info" | "warning") => void;
};

type BridgeConfiguration = {
  readonly host: BridgeHost;
  readonly onFrame: (line: string) => void;
  readonly platform: NodePlatform;
};

type Delivery = {
  readonly label: string;
  readonly messageId: string;
};

/**
 * Operations available from the acquired Bridge service.
 */
export type BridgeOperations = {
  readonly name: string;
  readonly listPeers: () => Effect.Effect<ReadonlyArray<SessionRecord>, never>;
  readonly receiveLine: (line: string) => Effect.Effect<void, BridgeFailure>;
  readonly sendMessage: (to: string, message: string) => Effect.Effect<Delivery, BridgeFailure>;
  readonly updateStatus: (status: "busy" | "idle") => Effect.Effect<void, never>;
};

class BridgeFailure extends Data.TaggedError("BridgeFailure")<{
  readonly message: string;
  readonly operation: string;
}> {}

/**
 * The single Effect service that owns the opt-in bridge lifecycle and peer operations.
 */
export class Bridge extends Context.Tag("@wyattjoh/pi-bridge/Bridge")<Bridge, BridgeOperations>() {}

/**
 * Creates the scoped Bridge layer for one enabled Pi session.
 *
 * @param configuration - Pi callbacks and the injectable Node boundary for this session.
 * @returns A layer whose scope owns bridge startup, rollback, and shutdown.
 */
export function createBridgeLayer(
  configuration: BridgeConfiguration,
): Layer.Layer<Bridge, BridgeFailure> {
  return Layer.scoped(Bridge, acquireBridge(configuration));
}

function acquireBridge(
  configuration: BridgeConfiguration,
): Effect.Effect<BridgeOperations, BridgeFailure, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startBridge(configuration),
      catch: (cause) => bridgeFailure("start bridge", cause),
    }),
    (state) =>
      Effect.tryPromise({
        try: () => state.stop(),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.void)),
  ).pipe(
    Effect.map((state) => ({
      name: state.name,
      listPeers: () =>
        Effect.tryPromise({
          try: () => state.listPeers(),
          catch: (cause) => bridgeFailure("list peers", cause),
        }).pipe(Effect.orElseSucceed(() => [])),
      receiveLine: (line) =>
        Effect.try({
          try: () => state.receiveLine(line),
          catch: (cause) => bridgeFailure("receive peer frame", cause),
        }),
      sendMessage: (to, message) =>
        Effect.tryPromise({
          try: () => state.sendMessage(to, message),
          catch: (cause) => bridgeFailure("send message", cause),
        }),
      updateStatus: (status) =>
        Effect.try({
          try: () => state.updateStatus(status),
          catch: (cause) =>
            new BridgeFailure({
              message: cause instanceof Error ? cause.message : String(cause),
              operation: "publish session status",
            }),
        }).pipe(
          Effect.catchAll((failure) =>
            Effect.sync(() => configuration.host.notify(failure.message, "warning")),
          ),
        ),
    })),
  );
}

function bridgeFailure(operation: string, cause: unknown): BridgeFailure {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new BridgeFailure({ message: `pi-bridge: ${operation} failed: ${detail}`, operation });
}

function resolveSessionsDirectory(platform: NodePlatform): string {
  const configDirectory =
    platform.environment("CLAUDE_CONFIG_DIR") ?? join(platform.homeDirectory(), ".claude");
  return join(configDirectory, "sessions");
}

function resolveSocketDirectory(platform: NodePlatform, sessionsDirectory: string): string {
  for (const record of readRecords(platform, sessionsDirectory)) {
    if (record.messagingSocketPath) return dirname(record.messagingSocketPath);
  }
  return join(platform.environment("XDG_RUNTIME_DIR") ?? platform.temporaryDirectory(), "cc-socks");
}

function readRecords(platform: NodePlatform, sessionsDirectory: string): SessionRecord[] {
  let files: string[];
  try {
    files = platform.readDirectory(sessionsDirectory);
  } catch {
    return [];
  }

  const records: SessionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = parseSessionRecord(
        JSON.parse(platform.readFile(join(sessionsDirectory, file))),
      );
      if (record) records.push(record);
    } catch {
      // A session record mid-write is not worth failing discovery over.
    }
  }
  return records;
}

function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (!isRecord(value) || typeof value.messagingSocketPath !== "string") return undefined;
  return {
    pid: typeof value.pid === "number" ? value.pid : Number.NaN,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    name: typeof value.name === "string" ? value.name : "",
    status: typeof value.status === "string" ? value.status : "unknown",
    messagingSocketPath: value.messagingSocketPath,
    peerProtocol: typeof value.peerProtocol === "number" ? value.peerProtocol : undefined,
    startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined,
  };
}

function recordIdentity(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): RecordIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    changedAt: stat.ctimeMs,
  };
}

function isSameRecord(left: RecordIdentity, right: RecordIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function hasOwnershipMarker(record: Record<string, unknown>): boolean {
  const marker = record._piBridge;
  return isRecord(marker) && Object.keys(marker).length === 1 && marker.recordVersion === 1;
}

function readOwnedRecordCandidate(
  platform: NodePlatform,
  path: string,
): OwnedRecordCandidate | undefined {
  try {
    const before = platform.lstat(path);
    if (!before.isFile()) return undefined;
    const beforeIdentity = recordIdentity(before);
    const contents = platform.readFile(path);
    const after = platform.lstat(path);
    if (!after.isFile()) return undefined;
    const afterIdentity = recordIdentity(after);
    if (!isSameRecord(beforeIdentity, afterIdentity)) return undefined;

    const record: unknown = JSON.parse(contents);
    if (!isRecord(record) || !hasOwnershipMarker(record)) return undefined;
    const socketPath = record.messagingSocketPath;
    if (typeof socketPath !== "string" || !isAbsolute(socketPath) || socketPath.includes("\0")) {
      return undefined;
    }
    return { path, contents, socketPath, identity: afterIdentity };
  } catch {
    return undefined;
  }
}

function probeSocket(platform: NodePlatform, socketPath: string): Promise<SocketProbeOutcome> {
  return new Promise((resolve) => {
    let probe: Socket;
    let settled = false;
    const settle = (outcome: SocketProbeOutcome) => {
      if (settled) return;
      settled = true;
      platform.destroySocket(probe);
      resolve(outcome);
    };

    try {
      probe = platform.connect({ path: socketPath });
    } catch {
      resolve("indeterminate");
      return;
    }

    platform.onceSocketConnect(probe, () => settle("reachable"));
    platform.onceSocketError(probe, (error) =>
      settle(
        errorCode(error) === "ENOENT" || errorCode(error) === "ECONNREFUSED"
          ? "unreachable"
          : "indeterminate",
      ),
    );
    platform.setSocketTimeout(probe, PROBE_TIMEOUT_MS, () => settle("indeterminate"));
  });
}

async function reapStaleRecords(platform: NodePlatform, sessionsDirectory: string): Promise<void> {
  let files: ReadonlyArray<{ readonly name: string; isFile: () => boolean }>;
  try {
    files = platform.readDirectoryEntries(sessionsDirectory);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const candidate = readOwnedRecordCandidate(platform, join(sessionsDirectory, file.name));
    if (!candidate || (await probeSocket(platform, candidate.socketPath)) !== "unreachable")
      continue;

    const current = readOwnedRecordCandidate(platform, candidate.path);
    if (
      !current ||
      current.contents !== candidate.contents ||
      !isSameRecord(current.identity, candidate.identity)
    ) {
      continue;
    }

    try {
      const finalStat = platform.lstat(candidate.path);
      if (!finalStat.isFile() || !isSameRecord(recordIdentity(finalStat), current.identity))
        continue;
      platform.unlink(candidate.path);
    } catch {
      // The candidate changed again or was already removed.
    }
  }
}

async function isLive(platform: NodePlatform, socketPath: string): Promise<boolean> {
  return (await probeSocket(platform, socketPath)) === "reachable";
}

function recordReference(record: SessionRecord): string {
  return formatPeerReference(record.sessionId);
}

function resolveTarget(
  to: string,
  selfPid: number,
  records: ReadonlyArray<SessionRecord>,
): { readonly path: string; readonly label: string } | { readonly error: string } {
  const trimmed = to.trim();
  if (trimmed.startsWith("uds:")) return { path: trimmed.slice(4), label: trimmed };
  if (trimmed.startsWith("/")) return { path: trimmed, label: `uds:${trimmed}` };

  const match = /^(.*?)\s*\[([0-9a-f]+)\]$/.exec(trimmed);
  const wantedName = (match?.[1] ?? trimmed).trim();
  const wantedReference = match?.[2];
  const candidates = records.filter(
    (record) =>
      record.pid !== selfPid &&
      record.name === wantedName &&
      (!wantedReference || recordReference(record).startsWith(wantedReference)),
  );
  const candidate = candidates[0];
  if (!candidate) {
    return { error: `No peer named '${wantedName}'. Run list_agents to see current peers.` };
  }
  if (candidates.length > 1) {
    const references = candidates
      .map((record) => `${record.name} [${recordReference(record)}]`)
      .join(", ");
    return { error: `'${wantedName}' is ambiguous. Re-send with a ref: ${references}` };
  }
  return { path: candidate.messagingSocketPath, label: candidate.name };
}

function sendFrame(platform: NodePlatform, socketPath: string, frame: PeerFrame): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let connection: Socket;
    try {
      connection = platform.connect({ path: socketPath });
    } catch (cause) {
      rejectOnce(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    platform.onceSocketConnect(connection, () => {
      platform.endSocket(connection, {
        bytes: `${JSON.stringify(frame)}\n`,
        onComplete: resolveOnce,
      });
    });
    platform.setSocketTimeout(connection, 5000, () => {
      platform.destroySocket(connection);
      rejectOnce(new Error(`Timed out writing to ${socketPath}`));
    });
    platform.onceSocketError(connection, rejectOnce);
  });
}

function prepareDirectory(
  platform: NodePlatform,
  path: string,
  createdDirectories: string[],
): void {
  const missingDirectories: string[] = [];
  let cursor = path;
  while (true) {
    try {
      const stat = platform.lstat(cursor);
      if (!stat.isDirectory()) throw new Error(`${cursor} is not a directory`);
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      missingDirectories.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }

  for (const missingDirectory of [...missingDirectories].reverse()) {
    try {
      platform.makeDirectory(missingDirectory, { mode: 0o700 });
      createdDirectories.unshift(missingDirectory);
      platform.chmod(missingDirectory, 0o700);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (!platform.lstat(missingDirectory).isDirectory()) {
        throw new Error(`${missingDirectory} is not a directory`);
      }
    }
  }
}

async function startBridge(configuration: BridgeConfiguration): Promise<{
  readonly name: string;
  readonly listPeers: () => Promise<ReadonlyArray<SessionRecord>>;
  readonly receiveLine: (line: string) => void;
  readonly sendMessage: (to: string, message: string) => Promise<Delivery>;
  readonly stop: () => Promise<void>;
  readonly updateStatus: (status: "busy" | "idle") => void;
}> {
  const { host, onFrame, platform } = configuration;
  const pid = platform.processId();
  const cwd = platform.cwd();
  const name = `pi-${basename(cwd).replace(/[^A-Za-z0-9_-]/g, "-")}-${pid}`.slice(0, 80);
  const sessionsDirectory = resolveSessionsDirectory(platform);
  const createdDirectories: string[] = [];
  const connections = new Set<Socket>();
  let server: Server | undefined;
  let socketPath = "";
  let recordPath = "";
  let selfAddress = "";
  let sessionId = "";
  let startedAt = 0;
  let recordPublished = false;
  let ownedRecordIdentity: RecordIdentity | undefined;
  let socketIdentity: PathIdentity | undefined;
  let statusDegradationWarned = false;

  const createRecord = (status: "busy" | "idle") => {
    const now = platform.now();
    return {
      pid,
      sessionId,
      cwd,
      startedAt,
      procStart: new Date(startedAt).toString(),
      version: `pi-${platform.environment("PI_VERSION") ?? "0.84.0"}`,
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

  const temporaryRecordPath = () =>
    join(dirname(recordPath), `.${basename(recordPath)}.${platform.randomIdentifier()}.tmp`);

  const withTemporaryRecord = (
    status: "busy" | "idle",
    publish: (temporaryPath: string) => void,
  ) => {
    const temporaryPath = temporaryRecordPath();
    try {
      platform.writeFile(temporaryPath, JSON.stringify(createRecord(status)), {
        flag: "wx",
        mode: 0o600,
      });
      platform.chmod(temporaryPath, 0o600);
      publish(temporaryPath);
    } finally {
      platform.removeFile(temporaryPath);
    }
  };

  const capturePublishedRecordIdentity = (temporaryIdentity: PathIdentity) => {
    const publishedStat = platform.lstat(recordPath);
    ownedRecordIdentity =
      publishedStat.isFile() &&
      publishedStat.dev === temporaryIdentity.device &&
      publishedStat.ino === temporaryIdentity.inode
        ? recordIdentity(publishedStat)
        : undefined;
  };

  const publishInitialRecord = () => {
    withTemporaryRecord("idle", (temporaryPath) => {
      const temporaryStat = platform.lstat(temporaryPath);
      platform.link(temporaryPath, recordPath);
      recordPublished = true;
      platform.unlink(temporaryPath);
      capturePublishedRecordIdentity({ device: temporaryStat.dev, inode: temporaryStat.ino });
    });
  };

  const rewriteRecord = (status: "busy" | "idle") => {
    withTemporaryRecord(status, (temporaryPath) => {
      const temporaryStat = platform.lstat(temporaryPath);
      platform.rename(temporaryPath, recordPath);
      capturePublishedRecordIdentity({ device: temporaryStat.dev, inode: temporaryStat.ino });
    });
  };

  const removeOwnedRecord = () => {
    if (!recordPublished || !ownedRecordIdentity) return;
    try {
      const before = platform.lstat(recordPath);
      if (!before.isFile() || !isSameRecord(recordIdentity(before), ownedRecordIdentity)) return;
      const record: unknown = JSON.parse(platform.readFile(recordPath));
      const after = platform.lstat(recordPath);
      if (!after.isFile() || !isSameRecord(recordIdentity(after), ownedRecordIdentity)) return;
      if (
        !isRecord(record) ||
        record.sessionId !== sessionId ||
        !isRecord(record._piBridge) ||
        record._piBridge.recordVersion !== 1
      ) {
        return;
      }
      platform.unlink(recordPath);
    } catch {
      // Leave anything whose ownership cannot be proven.
    }
  };

  const prepareSocketShutdown = (): PreservedSocketReplacement | undefined => {
    if (!socketIdentity) return undefined;
    try {
      const stat = platform.lstat(socketPath);
      if (
        stat.isSocket() &&
        stat.dev === socketIdentity.device &&
        stat.ino === socketIdentity.inode
      ) {
        platform.unlink(socketPath);
        return undefined;
      }
      if (stat.isDirectory()) return undefined;
      const preservedPath = join(
        dirname(socketPath),
        `.${basename(socketPath)}.${platform.randomIdentifier()}.replacement`,
      );
      platform.link(socketPath, preservedPath);
      return { path: preservedPath, identity: { device: stat.dev, inode: stat.ino } };
    } catch {
      return undefined;
    }
  };

  const restoreSocketReplacement = (
    preservedReplacement: PreservedSocketReplacement | undefined,
  ) => {
    if (!preservedReplacement) return;
    try {
      platform.link(preservedReplacement.path, socketPath);
      platform.unlink(preservedReplacement.path);
    } catch {
      try {
        const current = platform.lstat(socketPath);
        if (
          current.dev === preservedReplacement.identity.device &&
          current.ino === preservedReplacement.identity.inode
        ) {
          platform.unlink(preservedReplacement.path);
        }
      } catch {
        // Keep the replacement's hard link rather than deleting it.
      }
    }
  };

  const stop = async () => {
    for (const connection of connections) platform.destroySocket(connection);
    connections.clear();
    const preservedSocketReplacement = prepareSocketShutdown();
    if (server) await platform.closeServer(server);
    restoreSocketReplacement(preservedSocketReplacement);
    removeOwnedRecord();
    server = undefined;
    recordPublished = false;
    ownedRecordIdentity = undefined;
    socketIdentity = undefined;
  };

  const rollback = async () => {
    await stop();
    for (const path of createdDirectories) {
      try {
        platform.removeDirectory(path);
      } catch {
        // Keep pre-existing or now non-empty directories.
      }
    }
  };

  const receiveLine = (line: string) => {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      frame = parsed;
    } catch {
      host.notify(`pi-bridge: unparseable frame: ${line.slice(0, 120)}`, "warning");
      return;
    }
    if (frame.action === "peer_message_status") {
      host.notify(
        `pi-bridge: delivery ${String(frame.status)} for ${String(frame.orig_msg_id ?? "")}`,
        "info",
      );
      return;
    }
    if (frame.type !== "user") return;
    const message = isRecord(frame.message) ? frame.message : undefined;
    const content = typeof message?.content === "string" ? message.content : undefined;
    if (content) host.deliver(content);
  };

  const startServer = () => {
    const nextServer = platform.createServer({ allowHalfOpen: true }, (connection) => {
      connections.add(connection);
      let pendingFrame = Buffer.alloc(0);
      let rejected = false;
      const rejectOversizedFrame = () => {
        if (rejected) return;
        rejected = true;
        pendingFrame = Buffer.alloc(0);
        host.notify(`pi-bridge: peer frame exceeds ${MAX_PEER_FRAME_BYTES} byte limit`, "warning");
        platform.destroySocket(connection);
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
        if (line.trim()) onFrame(line);
      };
      platform.onSocketData(connection, (chunk) => {
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
      platform.onSocketEnd(connection, () => {
        if (rejected) return;
        if (pendingFrame.length > 0) processPendingFrame();
        platform.endSocket(connection, { bytes: undefined, onComplete: undefined });
      });
      platform.onSocketClose(connection, () => connections.delete(connection));
      platform.onSocketError(connection, () => connections.delete(connection));
    });
    server = nextServer;
    return platform.listenServer(nextServer, socketPath);
  };

  try {
    prepareDirectory(platform, sessionsDirectory, createdDirectories);
    await reapStaleRecords(platform, sessionsDirectory);
    const socketDirectory = resolveSocketDirectory(platform, sessionsDirectory);
    prepareDirectory(platform, socketDirectory, createdDirectories);
    socketPath = join(socketDirectory, `${pid}.sock`);
    recordPath = join(sessionsDirectory, `${pid}.json`);
    selfAddress = `uds:${socketPath}`;
    sessionId = platform.randomIdentifier();
    startedAt = platform.now();
    await startServer();
    const socketStat = platform.lstat(socketPath);
    socketIdentity = { device: socketStat.dev, inode: socketStat.ino };
    platform.chmod(socketPath, 0o600);
    const activeServer = server;
    if (!activeServer) throw new Error("server did not start");
    platform.unrefServer(activeServer);
    platform.onServerError(activeServer, (error) =>
      host.notify(`pi-bridge: server error: ${error.message}`, "error"),
    );
    publishInitialRecord();
  } catch (error) {
    await rollback();
    throw error;
  }

  return {
    name,
    async listPeers() {
      const records = readRecords(platform, sessionsDirectory).filter(
        (record) => record.pid !== pid,
      );
      const live = await Promise.all(
        records.map(async (record) =>
          (await isLive(platform, record.messagingSocketPath)) ? record : undefined,
        ),
      );
      return live.filter((record): record is SessionRecord => record !== undefined);
    },
    receiveLine,
    async sendMessage(to, message) {
      const target = resolveTarget(to, pid, readRecords(platform, sessionsDirectory));
      if ("error" in target) throw new Error(target.error);
      const messageId = platform.randomIdentifier();
      await sendFrame(platform, target.path, {
        msgV: 1,
        msg_id: messageId,
        type: "user",
        message: {
          role: "user",
          content:
            `<cross-session-message from="${selfAddress}" from-name="${name}" from-mode="prompting">\n` +
            `${message}\n</cross-session-message>`,
        },
        priority: "next",
        from: selfAddress,
      });
      return { label: target.label, messageId };
    },
    stop,
    updateStatus(status) {
      try {
        rewriteRecord(status);
      } catch (error) {
        if (statusDegradationWarned) return;
        statusDegradationWarned = true;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`pi-bridge: session status updates degraded: ${detail}`);
      }
    },
  };
}

/**
 * Formats a compatible short peer reference.
 *
 * @param sessionId - The peer session identifier.
 * @returns The first six hexadecimal identifier characters.
 */
export function formatPeerReference(sessionId: string | undefined): string {
  return (sessionId ?? "").replace(/-/g, "").slice(0, 6);
}
