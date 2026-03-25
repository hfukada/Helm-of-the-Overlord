import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Isolate DB before any imports that open it
process.env.HOTO_WORKSPACE = path.join(os.tmpdir(), `hoto-test-${crypto.randomUUID()}`);

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { MessagingManager } from "./manager";
import type { MessagingProvider } from "./interface";

function makeStubProvider(): MessagingProvider {
  return {
    connect: async () => {},
    disconnect: async () => {},
    getMainChannelId: () => null,
    createTaskChannel: async () => "channel-id",
    setChannelTopic: async () => {},
    archiveChannel: async () => {},
    sendMessage: async () => {},
    sendFormattedMessage: async () => {},
    inviteUser: async () => {},
    kickAllMembers: async () => {},
    onCommand: () => {},
    onMessage: () => {},
  };
}

describe("MessagingManager.handleMessage", () => {
  let manager: MessagingManager;
  let cmdAskSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    manager = new MessagingManager(makeStubProvider());
    (manager as unknown as Record<string, unknown>).mainChannelId = "main-channel-id";
    cmdAskSpy = spyOn(manager as unknown as Record<string, (...args: unknown[]) => unknown>, "cmdAsk").mockResolvedValue(undefined);
  });

  it("routes plain-text main-channel message to cmdAsk", async () => {
    const msg = {
      channelId: "main-channel-id",
      text: "what is the status of the project?",
      senderId: "user1",
      senderName: "User One",
    };
    await (manager as unknown as Record<string, (...args: unknown[]) => unknown>).handleMessage(msg);
    expect(cmdAskSpy).toHaveBeenCalledTimes(1);
    const calledWith = cmdAskSpy.mock.calls[0][0];
    expect(calledWith.command).toBe("ask");
    expect(calledWith.rawText).toBe(msg.text);
    expect(calledWith.channelId).toBe("main-channel-id");
  });

  it("ignores plain-text message in non-main, non-task channel", async () => {
    const msg = {
      channelId: "random-channel-id",
      text: "hello there",
      senderId: "user1",
      senderName: "User One",
    };
    await (manager as unknown as Record<string, (...args: unknown[]) => unknown>).handleMessage(msg);
    expect(cmdAskSpy).not.toHaveBeenCalled();
  });

  it("does not route !-prefixed message in main channel to cmdAsk", async () => {
    const handleCommandSpy = spyOn(manager as unknown as Record<string, (...args: unknown[]) => unknown>, "handleCommand").mockResolvedValue(undefined);
    const msg = {
      channelId: "main-channel-id",
      text: "!ask what is the status?",
      senderId: "user1",
      senderName: "User One",
    };
    await (manager as unknown as Record<string, (...args: unknown[]) => unknown>).handleMessage(msg);
    expect(cmdAskSpy).not.toHaveBeenCalled();
    // handleMessage returns early without calling handleCommand for !-prefixed messages
    // (commands are handled by the onCommand listener, not handleMessage)
    expect(handleCommandSpy).not.toHaveBeenCalled();
  });
});
