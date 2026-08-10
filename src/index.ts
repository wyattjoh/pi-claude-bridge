/**
 * pi-claude-bridge makes an opt-in Pi session addressable from Claude Code's
 * cross-session messaging tools. The bridge creates a Claude-compatible record
 * and newline-delimited JSON Unix socket only after `--bridge` is enabled.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, ManagedRuntime } from "effect";
import { Type } from "typebox";
import { Bridge, type BridgeOperations, createBridgeLayer, formatPeerReference } from "./bridge.ts";
import { nodePlatform, type NodePlatform } from "./platform.ts";

type SocketConnector = (options: { readonly path: string }) => import("node:net").Socket;

type BridgeOptions = {
  readonly connectSocket: SocketConnector | undefined;
  readonly platform: Partial<NodePlatform> | undefined;
};

/**
 * Registers the opt-in Claude Code peer integration.
 *
 * @param pi - Pi extension API used to register flags, lifecycle handlers, and peer tools.
 * @param options - Optional Node-boundary controls for lifecycle and transport tests.
 * @returns Nothing.
 */
export default function piBridge(
  pi: ExtensionAPI,
  options: BridgeOptions = { connectSocket: undefined, platform: undefined },
): void {
  pi.registerFlag("bridge", {
    description: "Make this pi session addressable from Claude Code peer messaging",
    type: "boolean",
    default: false,
  });

  let streaming = false;
  let starting = false;
  let toolsRegistered = false;
  let bridge: BridgeOperations | undefined;
  let runtime: ManagedRuntime.ManagedRuntime<Bridge, unknown> | undefined;
  let runInbound = (_line: string) => undefined;

  const platform: NodePlatform = {
    ...nodePlatform,
    ...options.platform,
    connect: options.connectSocket ?? options.platform?.connect ?? nodePlatform.connect,
  };

  const registerTools = () => {
    if (toolsRegistered) return;
    toolsRegistered = true;

    pi.registerTool({
      name: "list_agents",
      label: "List agents",
      description:
        "List live peer sessions on this machine (Claude Code sessions and other pi-claude-bridge sessions). " +
        "Returns each peer's name, ref, status, and working directory. Use the name as the 'to' argument of send_message.",
      parameters: Type.Object({}),
      async execute() {
        if (!runtime || !bridge) throw new Error("pi-claude-bridge is not ready");
        const peers = await runtime.runPromise(bridge.listPeers());
        if (peers.length === 0) {
          return { content: [{ type: "text", text: "No live peer sessions." }], details: {} };
        }
        const lines = peers.map(
          (peer) =>
            `${peer.name} [${formatPeerReference(peer.sessionId)}]  ·  ${peer.status ?? "unknown"}  ·  ${peer.cwd}`,
        );
        return {
          content: [
            { type: "text", text: `Peer sessions (${peers.length}):\n${lines.join("\n")}` },
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
        to: Type.String({ description: "Peer name, 'name [ref]', or uds: address" }),
        message: Type.String({ description: "Message body" }),
      }),
      async execute(_toolCallId, params) {
        if (!runtime || !bridge || !params) throw new Error("pi-claude-bridge is not ready");
        try {
          const delivery = await runtime.runPromise(bridge.sendMessage(params.to, params.message));
          return {
            content: [
              {
                type: "text",
                text: `Delivered to ${delivery.label} (msg_id ${delivery.messageId})`,
              },
            ],
            details: {},
          };
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error));
        }
      },
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("bridge") || runtime || starting) return;
    starting = true;

    const host = {
      deliver(content: string) {
        if (streaming) {
          pi.sendUserMessage(content, { deliverAs: "followUp" });
          return;
        }
        pi.sendUserMessage(content);
        ctx.ui.notify("Peer message received", "info");
      },
      notify(message: string, level: "error" | "info" | "warning") {
        ctx.ui.notify(message, level);
      },
    };
    const nextRuntime = ManagedRuntime.make(
      createBridgeLayer({ host, onFrame: (line) => runInbound(line), platform }),
    );
    try {
      const nextBridge = await nextRuntime.runPromise(
        Effect.gen(function* () {
          return yield* Bridge;
        }),
      );
      bridge = nextBridge;
      runtime = nextRuntime;
      runInbound = (line) => {
        runtime?.runCallback(nextBridge.receiveLine(line), {
          onExit: (exit) => {
            if (exit._tag === "Failure") {
              ctx.ui.notify("pi-claude-bridge: failed to process peer frame", "warning");
            }
          },
        });
      };
      registerTools();
      ctx.ui.setStatus("pi-claude-bridge", `peer: ${nextBridge.name}`);
    } catch (error) {
      await nextRuntime.dispose();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-claude-bridge: startup failed, bridge disabled: ${message}`, "error");
    } finally {
      starting = false;
    }
  });

  pi.on("session_shutdown", async () => {
    const currentRuntime = runtime;
    bridge = undefined;
    runtime = undefined;
    starting = false;
    runInbound = (_line: string) => undefined;
    await currentRuntime?.dispose();
  });
  pi.on("agent_start", async () => {
    streaming = true;
    if (runtime && bridge) await runtime.runPromise(bridge.updateStatus("busy"));
  });
  pi.on("agent_settled", async () => {
    streaming = false;
    if (runtime && bridge) await runtime.runPromise(bridge.updateStatus("idle"));
  });
}
