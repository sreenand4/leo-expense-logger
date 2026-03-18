import type { App } from "@slack/bolt";
import { requireOnboarded } from "../utils/slack";

export function registerHelpCommand(app: App): void {
  app.command("/help", async ({ ack, command, respond, logger }) => {
    await ack();

    // eslint-disable-next-line no-console
    console.log("[Help] command received", {
      userId: command.user_id,
      teamId: command.team_id,
      channelId: command.channel_id,
      channelName: command.channel_name,
    });

    const isReady = await requireOnboarded(command.user_id, command.team_id, respond);
    if (!isReady) return;

    try {
      await respond({
        response_type: "ephemeral",
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "ShootLogger · shoot expense bot",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "I keep your shoot expenses organized while you focus on shooting. DM me receipts or quick notes like `Uber $45` and I’ll log everything for you.",
            },
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*📁 Shoot management*",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "`/newshoot [name]`\nCreate a new shoot channel and linked expense sheet. This becomes your active shoot.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "`/setshoot [name]`\nSwitch your active shoot. New expenses will log to this shoot until you change it.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "`/wrapshoot`\nArchive the current shoot channel and post a final summary.",
            },
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*💸 Logging expenses*",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Once you have an active shoot:\n• DM me a receipt photo\n• Or type something like `coffee $6` or `gear rental $120`\n• Ask questions like `what's my total so far?`",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*🛠 Other*",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "`/ping`\nCheck that ShootLogger is up and responding.\n`/help`\nShow this help message.",
            },
          },
        ],
      });
    } catch (error) {
      logger.error(error);
    }
  });
}

