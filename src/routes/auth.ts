import { Request, Response, Router } from "express";
import { google } from "googleapis";
import { WebClient } from "@slack/web-api";
import {
  getSlackInstallation,
  getUser,
  setGoogleRefreshToken,
  setOnboardingStatus,
} from "../services/firestore";

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    `${process.env.SERVER_BASE_URL}/auth/google/callback`
  );
}

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

const router = Router();

router.get("/auth/google", (req: Request, res: Response) => {
  const userId = req.query.userId as string | undefined;

  if (!userId) {
    res.status(400).send("Missing userId parameter.");
    return;
  }

  const oauth2Client = createOAuth2Client();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state: userId,
  });

  res.redirect(authUrl);
});

router.get("/auth/google/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>❌ Authorization cancelled</h2>
        <p>You declined access. You can close this tab and try again from Slack.</p>
      </body></html>
    `);
    return;
  }

  if (!code || !state) {
    res.status(400).send("Missing code or state parameter.");
    return;
  }

  const userId = state;

  try {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.status(400).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>⚠️ Authorization incomplete</h2>
          <p>Google did not return a refresh token. Please return to Slack and try connecting again.</p>
        </body></html>
      `);
      return;
    }

    await setGoogleRefreshToken(userId, tokens.refresh_token);
    await setOnboardingStatus(userId, "ready");

    // Multi-tenant: use the workspace's bot token when available.
    let botToken = process.env.SLACK_BOT_TOKEN;
    const user = await getUser(userId);
    if (user?.workspaceId) {
      const installation = await getSlackInstallation(user.workspaceId);
      if (installation?.botToken) {
        botToken = installation.botToken;
      }
    }

    const slackClient = new WebClient(botToken);

    // `chat.postMessage` requires a channel ID (D...), not a user ID (U...).
    const im = await slackClient.conversations.open({
      users: userId,
      return_im: true,
    });
    const dmChannel = im.channel?.id;
    if (!dmChannel) {
      throw new Error("Failed to open DM channel with user.");
    }

    await slackClient.chat.postMessage({
      channel: dmChannel,
      text: "You're connected! Run /newshoot to create your first shoot.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "✅ *Google account connected successfully!*\n\nYou're all set. Head back to Slack and run `/newshoot [name]` to create your first shoot.",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Slate has access to Google Drive and Sheets on your behalf.",
            },
          ],
        },
      ],
    });

    res.status(200).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ Google account connected!</h2>
        <p>You can close this tab and return to Slack.</p>
        <p style="color:#888;font-size:14px">Slate now has access to your Google Drive and Sheets.</p>
      </body></html>
    `);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("OAuth callback error:", err);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>❌ Something went wrong</h2>
        <p>There was an error connecting your Google account. Please return to Slack and try again.</p>
      </body></html>
    `);
  }
});

export default router;
