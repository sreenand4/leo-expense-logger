import { App } from "@slack/bolt";
import * as firestore from "../services/firestore";
import * as sheets from "../services/sheets";
import {
  createChannel,
  inviteBotToChannel,
  inviteUserToChannel,
  pinMessage,
  postEphemeral,
  postToChannel,
} from "../services/slack";
import { requireOnboarded } from "../utils/slack";
import { toSlackChannelName } from "../utils/helpers";

function isNameTakenError(err: unknown): boolean {
  const code = (err as { data?: { error?: string } })?.data?.error;
  const message = (err as Error)?.message ?? "";
  return code === "name_taken" || message.includes("name_taken");
}

export function registerNewShootCommand(app: App): void {
  app.command("/newshoot", async ({ ack, command, respond, logger }) => {
    await ack();

    const isReady = await requireOnboarded(command.user_id, command.team_id, respond);
    if (!isReady) return;

    // Helper: ephemeral progress/error (avoids burning the single-use response_url)
    const ephemeral = (text: string) =>
      postEphemeral(command.channel_id, command.user_id, text);

    // 0. Check if the command is being run in a direct message
    if (command.channel_name !== 'directmessage') {
      await postEphemeral(
        command.channel_id,
        command.user_id,
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

    await ephemeral(`[1/5] *${rawName}* passed sanitization check. Creating channel...`);

    // 4. Create channel — wrap in try/catch for duplicate channel errors
    let channelId: string;
    try {
      channelId = await createChannel(channelName);
    } catch (err) {
      if (isNameTakenError(err)) {
        await ephemeral("A channel with that name already exists in slack. Try another name.");
        return;
      }
      logger.error(err);
      await ephemeral("Something went wrong creating the Slack channel. Try again or pick a different name.");
      return;
    }

    await ephemeral("[2/5] Channel created. Inviting bot and user to channel...");

    // 5. Invite bot to channel
    try {
      await inviteBotToChannel(channelId);
    } catch (err) {
      logger.error(err);
      await ephemeral("The channel was created but I couldn’t join it. You can invite me manually.");
      return;
    }

    // 5b. Invite the user who ran the command to the channel
    try {
      await inviteUserToChannel(channelId, command.user_id);
    } catch (err) {
      logger.error(err);
      // Don't block — channel and sheet still work; user can join manually
    }

    await ephemeral("[3/5] Bot and user invited to channel. Creating sheet...");

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

    await ephemeral("[4/5] Sheet created. Saving shoot to Firestore and setting as active shoot...");

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

    await ephemeral("[5/5] Shoot saved to Firestore and set as active shoot. Posting welcome message to channel...");

    // 9. Post welcome Block Kit message to channel (includes sheet URL) and pin it
    const welcomeTs = await postToChannel(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Shoot *${rawName}* is ready. Expense sheet: ${sheetUrl}`,
          },
        },
      ],
      `Shoot ${rawName} is ready. Expense sheet: ${sheetUrl}`
    );
    if (welcomeTs) {
      try {
        await pinMessage(channelId, welcomeTs);
      } catch (pinErr) {
        logger.warn("Failed to pin welcome message (channel still created):", pinErr);
      }
    }

    // 10. Final message: regular (non-ephemeral) so it's a visible, persistent reply (in DM or channel)
    const successText =
      `✅ *${rawName}* is all set up! Here's what I created:\n` +
      `• Channel: #${channelName} — check your sidebar and accept the invite to see the expense log\n` +
      `• Expense sheet: ${sheetUrl}\n\n` +
      `This is now your active shoot. Just send me an expense or drop a receipt photo to start logging to ${rawName}`;
    try {
      await postToChannel(command.channel_id, [], successText);
    } catch (err) {
      logger.error("Failed to post success message:", err);
    }
  });
}
