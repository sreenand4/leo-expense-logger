import dotenv from "dotenv";
import path from "path";
import express from "express";
import { App, ExpressReceiver } from "@slack/bolt";
import authRouter from "./routes/auth";
import slackAuthRouter from "./routes/slackAuth";
import { registerAppHomeHandler } from "./handlers/appHome";
import { registerHelpCommand } from "./commands/help";
import { registerNewShootCommand } from "./commands/newshoot";
import { registerPingCommand } from "./commands/ping";
import { registerSetShootCommand } from "./commands/setshoot";
import { registerWrapShootCommand } from "./commands/wrapshoot";
import { registerMessageHandler } from "./handlers/messages";

dotenv.config();

const { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, PORT, NODE_ENV } = process.env;

if (!SLACK_SIGNING_SECRET) {
  // Failing fast here avoids confusing runtime errors when Slack hits the app.
  // This is the only critical secret needed for request verification.
  throw new Error(
    "Missing SLACK_SIGNING_SECRET in environment. " +
    "Set it in a local .env file before starting the server."
  );
}

// ExpressReceiver gives us direct access to the underlying Express app.
// This lets us add non-Slack routes such as /healthz for Cloud Run.
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  // This is the default Slack events endpoint path; you'll plug this into Slack later.
  endpoints: "/slack/events",
});

// Serve static assets (install success / failure illustrations, icons, etc.)
receiver.app.use(
  "/assets",
  express.static(path.join(__dirname, "..", "assets"))
);

const app = new App({
  receiver,
  // Multi-tenant: prefer workspace-specific bot tokens from Firestore, but
  // fall back to SLACK_BOT_TOKEN for the original single-tenant setup.
  authorize: async ({ teamId }) => {
    const { getSlackInstallation } = await import("./services/firestore");

    if (teamId) {
      const installation = await getSlackInstallation(teamId);
      if (installation) {
        return {
          botToken: installation.botToken,
          botId: installation.botUserId,
          teamId: installation.workspaceId,
        };
      }
    }

    if (!SLACK_BOT_TOKEN) {
      throw new Error(
        "No Slack installation found for this workspace and SLACK_BOT_TOKEN is not set. " +
        "Install the app to the workspace or configure SLACK_BOT_TOKEN for single-tenant use."
      );
    }

    return {
      botToken: SLACK_BOT_TOKEN,
    };
  },
});

// Simple health check for Cloud Run, ngrok, and your own sanity.
receiver.router.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "expense-logger",
    env: NODE_ENV || "development",
  });
});

// Auth routes (OAuth) — must be registered before app.start()
receiver.router.use(authRouter);
receiver.router.use(slackAuthRouter);

async function start() {
  const port = Number(PORT) || 8080;

  await app.start(port);

  // Register slash commands
  registerPingCommand(app);
  registerHelpCommand(app);
  registerNewShootCommand(app);
  registerSetShootCommand(app);
  registerWrapShootCommand(app);
  registerAppHomeHandler(app);
  registerMessageHandler(app);

  // eslint-disable-next-line no-console
  console.log(
    `⚡️ Expense logger dev server is running on port ${port} in ${NODE_ENV || "development"} mode.`
  );
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start Slate server:", err);
  process.exit(1);
});

