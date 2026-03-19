import { Request, Response, Router } from "express";
import { google } from "googleapis";
import { WebClient } from "@slack/web-api";
import {
  getSlackInstallation,
  getUser,
  setGoogleRefreshToken,
  setOnboardingStatus,
} from "../services/firestore";
import { setUserStateCache } from "../utils/slack";

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
      <html>
        <head>
          <title>Authorization cancelled</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            :root {
              --background: #dae4a3;
            }

            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              background: var(--background);
              color: var(--foreground);
              font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
                sans-serif;
            }

            .wrap {
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 15px 16px;
              width: 100%;
              flex-direction: column;
            }

            .card {
              text-align: center;
              max-width: 520px;
            }

            .hero-image {
              display: block;
              margin: 0 auto 24px auto;
              max-width: min(440px, 90vw);
              height: auto;
            }

            h1 {
              margin: 0 0 12px 0;
              font-size: clamp(26px, 4vw, 32px);
              letter-spacing: 0.03em;
            }

            p {
              margin: 0 0 4px 0;
              font-size: 15px;
              line-height: 1.5;
              color: rgba(0, 0, 0, 0.75);
            }

            .hint {
              margin-top: 16px;
              font-size: 13px;
              opacity: 0.8;
            }
          </style>
        </head>
        <body>
          <div class="wrap">
            <div class="card">
              <img
                src="/assets/install-fail.png"
                alt="Google authorization cancelled"
                class="hero-image"
              />
              <h1>❌ Authorization cancelled</h1>
              <p>You declined access. You can close this tab and try again from Slack.</p>
            </div>
          </div>
        </body>
      </html>
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
        <html>
          <head>
            <title>Authorization incomplete</title>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <style>
              :root {
                --background: #dae4a3;
              }

              * {
                box-sizing: border-box;
              }

              body {
                margin: 0;
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                background: var(--background);
                color: var(--foreground);
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
                  sans-serif;
              }

              .wrap {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 15px 16px;
                width: 100%;
                flex-direction: column;
              }

              .card {
                text-align: center;
                max-width: 520px;
              }

              .hero-image {
                display: block;
                margin: 0 auto 24px auto;
                max-width: min(440px, 90vw);
                height: auto;
              }

              h1 {
                margin: 0 0 12px 0;
                font-size: clamp(26px, 4vw, 32px);
                letter-spacing: 0.03em;
              }

              p {
                margin: 0 0 4px 0;
                font-size: 15px;
                line-height: 1.5;
                color: rgba(0, 0, 0, 0.75);
              }

              .hint {
                margin-top: 16px;
                font-size: 13px;
                opacity: 0.8;
              }
            </style>
          </head>
          <body>
            <div class="wrap">
              <div class="card">
                <img
                  src="/assets/install-fail.png"
                  alt="Google authorization incomplete"
                  class="hero-image"
                />
                <h1>⚠️ Authorization incomplete</h1>
                <p>Google did not return a refresh token. Please return to Slack and try connecting again.</p>
              </div>
            </div>
          </body>
        </html>
      `);
      return;
    }

    await setGoogleRefreshToken(userId, tokens.refresh_token);
    await setOnboardingStatus(userId, "ready");
    setUserStateCache(userId, {
      onboardingStatus: "ready",
      googleRefreshToken: tokens.refresh_token,
    });

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
            text: "✅ *Google account connected successfully!*\n\nYou're all set! Here's a guide to get you started:",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "1. Run `/newshoot [name]` to create your first shoot.",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "2. Run `/setshoot [name]` to set your active shoot.",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "3. Run `/wrapshoot` to archive your shoot and get a summary.",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "4. Run `/help` to see a list of these commands again.",
          },
        }
      ],
    });

    res.status(200).send(`
      <html>
        <head>
          <title>Google account connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            :root {
              --background: #dae4a3;
            }

            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              background: var(--background);
              color: var(--foreground);
              font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
                sans-serif;
            }

            .wrap {
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 15px 16px;
              width: 100%;
              flex-direction: column;
            }

            .card {
              text-align: center;
              max-width: 520px;
            }

            .hero-image {
              display: block;
              margin: 0 auto 24px auto;
              max-width: min(440px, 90vw);
              height: auto;
            }

            h1 {
              margin: 0 0 12px 0;
              font-size: clamp(26px, 4vw, 32px);
              letter-spacing: 0.03em;
            }

            p {
              margin: 0 0 4px 0;
              font-size: 15px;
              line-height: 1.5;
              color: rgba(0, 0, 0, 0.75);
            }

            .hint {
              margin-top: 16px;
              font-size: 13px;
              opacity: 0.8;
            }
          </style>
        </head>
        <body>
          <div class="wrap">
            <div class="card">
              <img
                src="/assets/install-success.png"
                alt="Google account connected"
                class="hero-image"
              />
              <h1>✅ Google account connected!</h1>
              <p>You can close this tab and return to Slack.</p>
              <p class="hint">Leo now has access to your Google Drive and Sheets.</p>
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send(`
      <html>
        <head>
          <title>Google connection failed</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            :root {
              --background: #dae4a3;
            }

            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              background: var(--background);
              color: var(--foreground);
              font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
                sans-serif;
            }

            .wrap {
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 15px 16px;
              width: 100%;
              flex-direction: column;
            }

            .card {
              text-align: center;
              max-width: 520px;
            }

            .hero-image {
              display: block;
              margin: 0 auto 24px auto;
              max-width: min(440px, 90vw);
              height: auto;
            }

            h1 {
              margin: 0 0 12px 0;
              font-size: clamp(26px, 4vw, 32px);
              letter-spacing: 0.03em;
            }

            p {
              margin: 0 0 4px 0;
              font-size: 15px;
              line-height: 1.5;
              color: rgba(0, 0, 0, 0.75);
            }

            .hint {
              margin-top: 16px;
              font-size: 13px;
              opacity: 0.8;
            }
          </style>
        </head>
        <body>
          <div class="wrap">
            <div class="card">
              <img
                src="/assets/install-fail.png"
                alt="Google account connection failed"
                class="hero-image"
              />
              <h1>❌ Something went wrong</h1>
              <p>There was an error connecting your Google account. Please return to Slack and try again.</p>
            </div>
          </div>
        </body>
      </html>
    `);
  }
});

export default router;
