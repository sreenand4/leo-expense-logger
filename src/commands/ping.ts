import { App } from "@slack/bolt";

export function registerPingCommand(app: App): void {
  app.command("/ping", async ({ ack, respond, command, logger }) => {
    await ack();

    try {
      await respond({
        response_type: "ephemeral",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `ShootLogger is online and listening, <@${command.user_id}>!`,
            },
          },
        ],
      });
    } catch (error) {
      logger.error(error);
    }
  });
}

