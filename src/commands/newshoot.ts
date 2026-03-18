import { App } from "@slack/bolt";
import * as firestore from "../services/firestore";
import * as sheets from "../services/sheets";
import { requireOnboarded } from "../utils/slack";
import { toSlackChannelName } from "../utils/helpers";

function isNameTakenError(err: unknown): boolean {
  const code = (err as { data?: { error?: string } })?.data?.error;
  const message = (err as Error)?.message ?? "";
  return code === "name_taken" || message.includes("name_taken");
}

export function registerNewShootCommand(app: App): void {
  app.command("/newshoot", async ({ ack, command, respond, client, logger }) => {
    await ack();

    logger.info(`[NewShoot] command received`, {
      userId: command.user_id,
      teamId: command.team_id,
      channelId: command.channel_id,
      channelName: command.channel_name,
      text: command.text,
    });

    const isReady = await requireOnboarded(command.user_id, command.team_id, respond);
    if (!isReady) return;

    // Placeholder + in-place updates
    await respond({
      response_type: "ephemeral",
      text: "Working on it…",
    });
    const ephemeral = (text: string) =>
      respond({
        response_type: "ephemeral",
        replace_original: true,
        text,
      });

    // 0. Check if the command is being run in a direct message
    if (command.channel_name !== 'directmessage') {
      await ephemeral(
        "Please use this command in our DMs. Find me in your sidebar under Direct Messages."
      );
      return;
    }

    // 1. No shoot name provided
    const rawName = (command.text ?? "").trim();
    if (!rawName) {
      await ephemeral("Please provide a shoot name, e.g. `/newshoot nike-campaign-march`");
      return;
    }

    // 2. Sanitize name to lowercase-hyphenated format
    const channelName = toSlackChannelName(rawName);
    if (!channelName) {
      await ephemeral("That name isn't valid for a Slack channel. Use letters, numbers, hyphens, or underscores.");
      return;
    }

    console.log("[NewShoot] [1/5] name passed sanitization, creating channel...");

    // 4. Create channel — wrap in try/catch for duplicate channel errors
    let channelId: string;
    try {
      const created = await client.conversations.create({
        name: channelName,
        is_private: false,
      });
      channelId = created.channel?.id as string;
      if (!channelId) {
        throw new Error("Slack API did not return a channel ID.");
      }
    } catch (err) {
      if (isNameTakenError(err)) {
        await ephemeral("A channel with that name already exists in slack. Try another name.");
        return;
      }
      logger.error(err);
      await ephemeral("Something went wrong creating the Slack channel. Try again or pick a different name.");
      return;
    }

    console.log("[NewShoot] [2/5] channel created, inviting user...", {
      channelId,
    });

    // 5. Invite the user who ran the command to the channel
    try {
      await client.conversations.invite({
        channel: channelId,
        users: command.user_id,
      });
    } catch (err) {
      logger.error(err);
      // Don't block — channel and sheet still work; user can join manually
    }

    console.log("[NewShoot] [3/5] user invited, creating sheet...");

    // 6. Create shoot sheet
    let sheetId: string;
    let sheetUrl: string;
    try {
      const sheet = await sheets.createShootSheet(command.user_id, rawName);
      sheetId = sheet.sheetId;
      sheetUrl = sheet.sheetUrl;
    } catch (err) {
      logger.error(err);
      await ephemeral("The channel was created but the expense sheet couldn’t be created. Check the server logs.");
      return;
    }

    console.log("[NewShoot] [4/5] sheet created, saving shoot in Firestore...");

    // 7. Save shoot to Firestore | 8. Set as active shoot
    let shootId: string;
    try {
      shootId = await firestore.createShoot(
        channelName,
        channelId,
        sheetId,
        command.user_id
      );
      await firestore.setActiveShoot(command.user_id, shootId);
    } catch (err) {
      logger.error(err);
      await ephemeral("The channel and sheet were created but shoot state couldn’t be saved. Check the server logs.");
      return;
    }

    console.log("[NewShoot] [5/5] shoot saved and set active, posting welcome message...", {
      channelId,
      shootId,
    });

    // 9. Post welcome Block Kit message to channel (includes sheet URL) and pin it
    try {
      const welcome = await client.chat.postMessage({
        channel: channelId,
        text: `Shoot ${rawName} is ready. Expense sheet: ${sheetUrl}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Shoot *${rawName}* is ready. Expense sheet: ${sheetUrl}`,
            },
          },
        ],
      });
      const welcomeTs = welcome.ts;
      if (welcomeTs) {
        try {
          await client.pins.add({
            channel: channelId,
            timestamp: welcomeTs,
          });
        } catch (pinErr) {
          logger.warn("Failed to pin welcome message (channel still created):", pinErr);
        }
      }
    } catch (postErr) {
      logger.error("Failed to post welcome message to shoot channel:", postErr);
    }

    // 10. Final message: regular (non-ephemeral) so it's a visible, persistent reply (in DM or channel)
    const successText =
      `✅ *${rawName}* is all set up! Here's what I created:\n` +
      `• Channel: #${channelName} — check your sidebar and accept the invite to see the expense log\n` +
      `• Expense sheet: ${sheetUrl}\n\n` +
      `This is now your active shoot. Just send me an expense or drop a receipt photo to start logging to ${rawName}`;
    await ephemeral(successText);
  });
}
