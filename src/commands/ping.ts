import { App } from "@slack/bolt";

export function registerPingCommand(app: App): void {
  app.command("/ping", async ({ ack, respond, command, logger }) => {
    await ack();

    try {
      console.log("[Ping] command received", {
        userId: command.user_id,
        teamId: command.team_id,
        channelId: command.channel_id,
        channelName: command.channel_name,
      });

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

