import { WebClient } from "@slack/web-api";

let clientInstance: WebClient | null = null;

function getClient(): WebClient {
  if (clientInstance) return clientInstance;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is not set in environment.");
  }
  clientInstance = new WebClient(token);
  return clientInstance;
}

/**
 * Create a public Slack channel. Returns the channel ID.
 */
export async function createChannel(name: string): Promise<string> {
  const result = await getClient().conversations.create({
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
  await getClient().conversations.join({
    channel: channelId,
  });
}

/**
 * Archive a Slack channel. Uses conversations.archive.
 */
export async function archiveChannel(channelId: string): Promise<void> {
  await getClient().conversations.archive({
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
  await getClient().conversations.invite({
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
  blocks: unknown[],
  text: string
): Promise<string | undefined> {
  const result = await getClient().chat.postMessage({
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
  await getClient().pins.add({
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
  await getClient().chat.postEphemeral({
    channel: channelId,
    user: userId,
    text,
  });
}
