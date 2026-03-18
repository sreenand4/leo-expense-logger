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

    // 0. Check if the command is being run in a direct message
    if (command.channel_name !== "directmessage") {
      await respond({
        response_type: "ephemeral",
        text:
          "Please use this command in our DMs. Find me in your sidebar under Direct Messages.",
      });
      return;
    }

    // Single placeholder message in the DM that we'll keep updating in-place.
    let placeholderTs: string | undefined;
    const updatePlaceholder = async (text: string, blocks?: any[]) => {
      if (!placeholderTs) {
        const created = await client.chat.postMessage({
          channel: command.channel_id,
          text,
          ...(blocks ? { blocks } : {}),
        });
        placeholderTs = created.ts;
      } else {
        await client.chat.update({
          channel: command.channel_id,
          ts: placeholderTs,
          text,
          ...(blocks ? { blocks } : {}),
        });
      }
    };

    // 1. No shoot name provided
    const rawName = (command.text ?? "").trim();
    if (!rawName) {
      await updatePlaceholder(
        "Please provide a shoot name, e.g. `/newshoot nike-campaign-march`"
      );
      return;
    }

    // 2. Sanitize name to lowercase-hyphenated format
    const channelName = toSlackChannelName(rawName);
    if (!channelName) {
      await updatePlaceholder(
        "That name isn't valid for a Slack channel. Use letters, numbers, hyphens, or underscores."
      );
      return;
    }

    await updatePlaceholder("Validating name…");

    console.log("[NewShoot] [1/5] name passed sanitization, creating channel...");

    // 4. Create channel — wrap in try/catch for duplicate channel errors
    await updatePlaceholder("Creating Slack channel…");
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
        await updatePlaceholder(
          "A channel with that name already exists in Slack. Try another name."
        );
        return;
      }
      logger.error(err);
      await updatePlaceholder(
        "Something went wrong creating the Slack channel. Try again or pick a different name."
      );
      return;
    }

    console.log("[NewShoot] [2/5] channel created, inviting user + creating sheet...", {
      channelId,
    });

    // 5-6. Invite user and create shoot sheet in parallel to reduce total setup time.
    await updatePlaceholder("Creating Google Sheet…");
    const [inviteResult, sheetResult] = await Promise.allSettled([
      client.conversations.invite({
        channel: channelId,
        users: command.user_id,
      }),
      sheets.createShootSheet(command.user_id, rawName),
    ]);

    if (inviteResult.status === "rejected") {
      logger.error(inviteResult.reason);
      // Don't block — channel and sheet still work; user can join manually
    }

    let sheetId: string;
    let sheetUrl: string;
    if (sheetResult.status === "rejected") {
      logger.error(sheetResult.reason);
      await updatePlaceholder(
        "The channel was created but the expense sheet couldn’t be created. Check the server logs."
      );
      return;
    }
    sheetId = sheetResult.value.sheetId;
    sheetUrl = sheetResult.value.sheetUrl;

    console.log("[NewShoot] [3/5] sheet created, saving shoot in Firestore...");

    // 7. Save shoot to Firestore | 8. Set as active shoot
    await updatePlaceholder("Setting as your active shoot…");
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
      await updatePlaceholder(
        "The channel and sheet were created but shoot state couldn’t be saved. Check the server logs."
      );
      return;
    }

    console.log("[NewShoot] [4/5] shoot saved and set active, posting welcome message...", {
      channelId,
      shootId,
    });

    // 9. Post welcome Block Kit message to channel (includes sheet URL) and pin it
    try {
      const welcome = await client.chat.postMessage({
        channel: channelId,
        text: `Shoot ${channelName || rawName} is ready. Expense sheet: ${sheetUrl}`,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `${channelName || rawName} is ready`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `All expenses you log for *${channelName || rawName}* will be reflected here in this channel for quick reference.\n\n` +
                "You can also open the full external sheet at any time:",
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Open expense sheet",
                  emoji: true,
                },
                style: "primary",
                url: sheetUrl,
              },
            ],
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

    // 10. Final message: update the same placeholder with final Block Kit
    await updatePlaceholder(
      `*${channelName || rawName}* is all set up!`,
      [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `#${channelName || rawName} is all set up!`,
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `This is now your active shoot. Send me an expense or photo and I'll log it to *${channelName || rawName}*.`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Expense Sheet",
                emoji: true,
              },
              style: "primary",
              url: sheetUrl,
            },
          ],
        },
      ]
    );
  });
}
