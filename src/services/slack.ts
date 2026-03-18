import { WebClient } from "@slack/web-api";
import { getSlackInstallation, getUser } from "./firestore";

async function getClientForUser(userId: string): Promise<WebClient> {
  const user = await getUser(userId);
  const workspaceId = user?.workspaceId;

  if (workspaceId) {
    const installation = await getSlackInstallation(workspaceId);
    if (installation?.botToken) {
      return new WebClient(installation.botToken);
    }
  }

  const fallbackToken = process.env.SLACK_BOT_TOKEN;
  if (!fallbackToken) {
    throw new Error(
      "No installation bot token found for user and SLACK_BOT_TOKEN is not set."
    );
  }
  return new WebClient(fallbackToken);
}

/**
 * Create a public Slack channel. Returns the channel ID.
 */
export async function createChannel(name: string): Promise<string> {
  const result = await new WebClient(process.env.SLACK_BOT_TOKEN).conversations.create({
    name,
    is_private: false,
  });

  const channelId = result.channel?.id;
  if (!channelId) {
    throw new Error("Slack API did not return a channel ID.");
  }
  return channelId;
}

/**
 * Have the bot join the channel (e.g. after creating it). Uses conversations.join —
 * the bot whose token is used joins; no user ID needed.
 */
export async function inviteBotToChannel(channelId: string): Promise<void> {
  await new WebClient(process.env.SLACK_BOT_TOKEN).conversations.join({
    channel: channelId,
  });
}

/**
 * Archive a Slack channel. Uses conversations.archive.
 */
export async function archiveChannel(channelId: string): Promise<void> {
  await new WebClient(process.env.SLACK_BOT_TOKEN).conversations.archive({
    channel: channelId,
  });
}

/**
 * Invite a user to a channel. Uses conversations.invite with channel and user ID.
 */
export async function inviteUserToChannel(
  channelId: string,
  userId: string
): Promise<void> {
  const client = await getClientForUser(userId);
  await client.conversations.invite({
    channel: channelId,
    users: userId,
  });
}

/**
 * Post a Block Kit message to a channel. text is used as fallback in notifications.
 * Returns the message timestamp (ts) so callers can e.g. pin the message.
 */
export async function postToChannel(
  channelId: string,
  userId: string | null,
  blocks: unknown[],
  text: string
): Promise<string | undefined> {
  const client =
    userId != null ? await getClientForUser(userId) : new WebClient(process.env.SLACK_BOT_TOKEN);
  const result = await client.chat.postMessage({
    channel: channelId,
    text,
    blocks,
  } as { channel: string; text: string; blocks: unknown[] });
  return result.ts;
}

/**
 * Pin a message in a channel. Requires pins:write scope.
 * Use the ts returned from postToChannel (or from chat.postMessage).
 */
export async function pinMessage(
  channelId: string,
  messageTs: string
): Promise<void> {
  await new WebClient(process.env.SLACK_BOT_TOKEN).pins.add({
    channel: channelId,
    timestamp: messageTs,
  });
}

/**
 * Post an ephemeral message to a user in a channel (only they see it).
 * Use this instead of respond() when the slash command response_url may already be used or expired.
 */
export async function postEphemeral(
  channelId: string,
  userId: string,
  text: string
): Promise<void> {
  const client = await getClientForUser(userId);
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text,
  });
}
