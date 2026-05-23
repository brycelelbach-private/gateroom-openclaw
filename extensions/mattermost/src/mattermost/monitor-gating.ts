import type { ChatType, OpenClawConfig } from "./runtime-api.js";

export function mapMattermostChannelTypeToChatType(channelType?: string | null): ChatType {
  if (!channelType) {
    return "channel";
  }
  const normalized = channelType.trim().toUpperCase();
  if (normalized === "D") {
    return "direct";
  }
  if (normalized === "G" || normalized === "P") {
    return "group";
  }
  return "channel";
}

export function resolveMattermostTrustedChatKind(params: {
  channelType?: string | null;
  fallback?: ChatType;
}): ChatType {
  const channelType = params.channelType?.trim();
  if (channelType) {
    return mapMattermostChannelTypeToChatType(channelType);
  }
  return params.fallback ?? "channel";
}

export type MattermostRequireMentionResolverInput = {
  cfg: OpenClawConfig;
  channel: "mattermost";
  accountId: string;
  groupId: string;
  requireMentionOverride?: boolean;
};

export type MattermostMentionGateInput = {
  kind: ChatType;
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  threadRootId?: string;
  requireMentionOverride?: boolean;
  resolveRequireMention: (params: MattermostRequireMentionResolverInput) => boolean;
  wasMentioned: boolean;
  isControlCommand: boolean;
  commandAuthorized: boolean;
  oncharEnabled: boolean;
  oncharTriggered: boolean;
  canDetectMention: boolean;
};

type MattermostMentionGateDecision = {
  shouldRequireMention: boolean;
  shouldBypassMention: boolean;
  effectiveWasMentioned: boolean;
  dropReason: "onchar-not-triggered" | "missing-mention" | null;
};

export function evaluateMattermostMentionGate(
  params: MattermostMentionGateInput,
): MattermostMentionGateDecision {
  const shouldRequireMention =
    params.kind !== "direct" &&
    params.resolveRequireMention({
      cfg: params.cfg,
      channel: "mattermost",
      accountId: params.accountId,
      groupId: params.channelId,
      requireMentionOverride: params.requireMentionOverride,
    });
  const shouldBypassMention =
    params.isControlCommand &&
    shouldRequireMention &&
    !params.wasMentioned &&
    params.commandAuthorized;
  const effectiveWasMentioned =
    params.wasMentioned || shouldBypassMention || params.oncharTriggered;
  if (
    params.oncharEnabled &&
    !params.oncharTriggered &&
    !params.wasMentioned &&
    !params.isControlCommand
  ) {
    return {
      shouldRequireMention,
      shouldBypassMention,
      effectiveWasMentioned,
      dropReason: "onchar-not-triggered",
    };
  }
  if (
    params.kind !== "direct" &&
    shouldRequireMention &&
    params.canDetectMention &&
    !effectiveWasMentioned
  ) {
    return {
      shouldRequireMention,
      shouldBypassMention,
      effectiveWasMentioned,
      dropReason: "missing-mention",
    };
  }
  return {
    shouldRequireMention,
    shouldBypassMention,
    effectiveWasMentioned,
    dropReason: null,
  };
}

export type MattermostMachineEmittedPostInput = {
  fromBot?: string | null;
  fromWebhook?: string | null;
  hasControlCommand: boolean;
};

export type MattermostMachineEmittedPostDecision =
  | { drop: false }
  | { drop: true; reason: "from_bot" | "from_webhook" };

/**
 * Decide whether a Mattermost post that carries `props.from_bot=true`
 * or `props.from_webhook=true` should be dropped before reaching the
 * dispatch path. Machine-emitted posts are dropped to prevent
 * bot-to-bot loops, but registered openclaw control commands (e.g.
 * `/acp spawn claude --bind here` posted by an external orchestrator
 * bot) legitimately need to flow through to the slash dispatcher.
 */
export function decideMattermostMachineEmittedPost(
  input: MattermostMachineEmittedPostInput,
): MattermostMachineEmittedPostDecision {
  const fromBot = input.fromBot === "true";
  const fromWebhook = input.fromWebhook === "true";
  if (!fromBot && !fromWebhook) {
    return { drop: false };
  }
  if (input.hasControlCommand) {
    return { drop: false };
  }
  if (fromBot) {
    return { drop: true, reason: "from_bot" };
  }
  return { drop: true, reason: "from_webhook" };
}
