import { describe, expect, test } from "bun:test";
import ccPeer from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type FlagDefinition = {
  default?: unknown;
  description: string;
  type: string;
};

function createHarness() {
  const flags = new Map<string, FlagDefinition>();
  const handlers = new Map<string, Handler>();
  const tools: string[] = [];
  const pi = {
    getFlag() {
      return undefined;
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
  };

  return { flags, handlers, pi, tools };
}

describe("cc-peer opt-in", () => {
  test("stays inactive unless --claude-peer is provided", async () => {
    const harness = createHarness();
    ccPeer(harness.pi as never);

    expect(harness.flags.get("claude-peer")).toEqual({
      default: false,
      description: "Make this pi session addressable from Claude Code peer messaging",
      type: "boolean",
    });
    expect(harness.tools).toEqual([]);

    await harness.handlers.get("session_start")?.({}, {});
    await harness.handlers.get("agent_start")?.({}, {});
    await harness.handlers.get("agent_settled")?.({}, {});
    await harness.handlers.get("session_shutdown")?.({}, {});

    expect(harness.tools).toEqual([]);
  });
});
