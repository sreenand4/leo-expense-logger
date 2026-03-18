import { Router } from "express";
import { WebClient } from "@slack/web-api";
import { Timestamp } from "@google-cloud/firestore";
import { saveSlackInstallation } from "../services/firestore";

const router = Router();

const clientId = process.env.SLACK_CLIENT_ID;
const clientSecret = process.env.SLACK_CLIENT_SECRET;
const serverBaseUrl = process.env.SERVER_BASE_URL;

if (!clientId || !clientSecret) {
  // eslint-disable-next-line no-console
  console.warn(
    "[SlackAuth] SLACK_CLIENT_ID or SLACK_CLIENT_SECRET is not set. " +
    "Slack OAuth installation will not work until these are configured."
  );
}

if (!serverBaseUrl) {
  // eslint-disable-next-line no-console
  console.warn(
    "[SlackAuth] SERVER_BASE_URL is not set. " +
    "Slack OAuth redirect URL will be incorrect until this is configured."
  );
}

const slackWeb = new WebClient();

router.get("/slack/oauth_redirect", async (req, res) => {
  const code = req.query.code as string | undefined;

  if (!code || !clientId || !clientSecret || !serverBaseUrl) {
    // eslint-disable-next-line no-console
    console.error(
      "[SlackAuth] Missing code or required env vars in /slack/oauth_redirect",
      { hasCode: Boolean(code), clientIdSet: Boolean(clientId), clientSecretSet: Boolean(clientSecret), serverBaseUrlSet: Boolean(serverBaseUrl) }
    );
    return res.redirect("/install-fail");
  }

  const redirectUri = `${serverBaseUrl}/slack/oauth_redirect`;

  try {
    const result = await slackWeb.oauth.v2.access({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const workspaceId = result.team?.id;
    const workspaceName = result.team?.name ?? "Unknown workspace";
    const botToken = result.access_token;
    const botUserId = result.bot_user_id;
    const installedBy = result.authed_user?.id ?? "unknown";

    if (!workspaceId || !botToken || !botUserId) {
      // eslint-disable-next-line no-console
      console.error("[SlackAuth] Missing workspaceId, botToken, or botUserId from oauth.v2.access response", {
        workspaceId,
        hasBotToken: Boolean(botToken),
        botUserId,
      });
      return res.redirect("/install-fail");
    }

    await saveSlackInstallation({
      workspaceId,
      workspaceName,
      botToken,
      botUserId,
      installedBy,
      installedAt: Timestamp.now(),
    });

    return res.redirect("/install-success");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[SlackAuth] Slack OAuth failed:", err);
    return res.redirect("/install-fail");
  }
});

router.get("/install-success", (_req, res) => {
  const html = `
    <html>
      <head>
        <title>Leo is good to go!</title>
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
            color: rgba(218, 228, 163, 0.86);
          }

          .hint {
            margin-top: 16px;
            font-size: 13px;
            opacity: 0.8;
          }

          a {
            margin-top: 16px;
            text-align: center;
            color: #000000;
            text-decoration: none;
            font-weight: 500;
          }
        </style>
      </head>
      <body>
        <div class="wrap">
            <img
              src="/assets/install-success.png",
              width="100%",
              alt="Leo successfully installed"
              class="hero-image"
            />
            <a href="https://app.slack.com/">Go to Slack <span class="arrow">→</span></a>
        </div>
      </body>
    </html>
  `;

  res.status(200).send(html);
});

router.get("/install-fail", (_req, res) => {
  const html = `
    <html>
      <head>
        <title>Leo installation failed</title>
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
            color: rgba(218, 228, 163, 0.86);
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
            <img
              src="/assets/install-fail.png",
              width="100%",
              alt="Leo installation failed"
              class="hero-image"
            />
        </div>
      </body>
    </html>
  `;

  res.status(200).send(html);
});

export default router;

