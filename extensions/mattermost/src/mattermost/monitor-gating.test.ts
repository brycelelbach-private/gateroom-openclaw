import { describe, expect, it, vi } from "vitest";
import {
  decideMattermostMachineEmittedPost,
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
  resolveMattermostTrustedChatKind,
} from "./monitor-gating.js";

describe("mattermost monitor gating", () => {
  it("maps mattermost channel types to chat types", () => {
    expect(mapMattermostChannelTypeToChatType("D")).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("G")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("P")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("O")).toBe("channel");
    expect(mapMattermostChannelTypeToChatType(undefined)).toBe("channel");
  });

  it("derives chat kind from trusted channel lookup before fallback state", () => {
    expect(
      resolveMattermostTrustedChatKind({
        channelType: "O",
        fallback: "direct",
      }),
    ).toBe("channel");
    expect(
      resolveMattermostTrustedChatKind({
        channelType: "D",
        fallback: "channel",
      }),
    ).toBe("direct");
    expect(resolveMattermostTrustedChatKind({ fallback: "group" })).toBe("group");
    expect(resolveMattermostTrustedChatKind({})).toBe("channel");
  });

  it("drops non-mentioned traffic when onchar is enabled but not triggered", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        kind: "channel",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: false,
        commandAuthorized: false,
        oncharEnabled: true,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: false,
      effectiveWasMentioned: false,
      dropReason: "onchar-not-triggered",
    });
  });

  it("bypasses mention for authorized control commands and allows direct chats", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        kind: "channel",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: true,
        commandAuthorized: true,
        oncharEnabled: false,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: true,
      effectiveWasMentioned: true,
      dropReason: null,
    });

    expect(
      evaluateMattermostMentionGate({
        kind: "direct",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: false,
        commandAuthorized: false,
        oncharEnabled: false,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toMatchObject({
      shouldRequireMention: false,
      dropReason: null,
    });
  });
});

describe("decideMattermostMachineEmittedPost", () => {
  it("does not drop user posts (no machine-emitted props)", () => {
    expect(
      decideMattermostMachineEmittedPost({
        fromBot: undefined,
        fromWebhook: undefined,
        hasControlCommand: false,
      }),
    ).toEqual({ drop: false });
  });

  it("drops bot posts that are not control commands", () => {
    expect(
      decideMattermostMachineEmittedPost({
        fromBot: "true",
        fromWebhook: undefined,
        hasControlCommand: false,
      }),
    ).toEqual({ drop: true, reason: "from_bot" });
  });

  it("drops webhook posts that are not control commands", () => {
    expect(
      decideMattermostMachineEmittedPost({
        fromBot: undefined,
        fromWebhook: "true",
        hasControlCommand: false,
      }),
    ).toEqual({ drop: true, reason: "from_webhook" });
  });

  it("does not drop bot posts that ARE control commands (e.g. /acp spawn)", () => {
    // Carve-out for orchestrator bots that legitimately post slash
    // commands. Without this, `/acp spawn claude --bind here` from a
    // sibling bot is silently dropped and the channel never binds.
    expect(
      decideMattermostMachineEmittedPost({
        fromBot: "true",
        fromWebhook: undefined,
        hasControlCommand: true,
      }),
    ).toEqual({ drop: false });
  });

  it("does not drop webhook posts that ARE control commands", () => {
    expect(
      decideMattermostMachineEmittedPost({
        fromBot: undefined,
        fromWebhook: "true",
        hasControlCommand: true,
      }),
    ).toEqual({ drop: false });
  });

  it("treats anything other than the literal string \"true\" as not machine-emitted", () => {
    // Mattermost serializes props as strings; only the exact string
    // "true" is the live signal. Booleans / other strings should not
    // trigger the drop.
    expect(
      decideMattermostMachineEmittedPost({
        fromBot: "false",
        fromWebhook: null,
        hasControlCommand: false,
      }),
    ).toEqual({ drop: false });
  });

  it("prefers from_bot reason when both flags are set", () => {
    expect(
      decideMattermostMachineEmittedPost({
        fromBot: "true",
        fromWebhook: "true",
        hasControlCommand: false,
      }),
    ).toEqual({ drop: true, reason: "from_bot" });
  });
});
