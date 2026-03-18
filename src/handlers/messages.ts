import { App, Block, KnownBlock } from "@slack/bolt";
import { getOrCreateUser } from "../services/firestore";
import { handleLLMMessage } from "../services/llm";
import { uploadMultipleReceiptImages } from "../services/storage";
import { getConnectGoogleBlocks, getConnectGoogleMessage } from "../utils/slack";

const HANDLER_LOG = "[Handler]";

function looksLikePng(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

function looksLikeJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

async function fetchSlackFileWithAuth(
  url: string,
  token: string,
  maxRedirects = 5
): Promise<Response> {
  // Node/undici drops Authorization on cross-origin redirects.
  // Slack file URLs frequently 302 to a workspace domain, so we must follow manually
  // and re-send the Bearer token each time.
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/octet-stream",
      },
      redirect: "manual",
    });

    if (
      res.status === 301 ||
      res.status === 302 ||
      res.status === 303 ||
      res.status === 307 ||
      res.status === 308
    ) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }

    return res;
  }

  return await fetch(current, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/octet-stream",
    },
  });
}

export function registerMessageHandler(app: App): void {
  app.message(async ({ message, client, logger, context }) => {
    let placeholder: { ts?: string } | null = null;
    try {
      if (message.channel_type !== "im") {
        return;
      }

      const msg = message as unknown as Record<string, unknown>;
      const subtype = msg.subtype as string | undefined;
      const BLOCKED_SUBTYPES = [
        "bot_message",
        "message_changed",
        "message_deleted",
      ];
      if (msg.bot_id || (subtype && BLOCKED_SUBTYPES.includes(subtype))) {
        return;
      }

      const userId = msg.user as string | undefined;
      if (!userId) {
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`${HANDLER_LOG} DM received from ${userId}`);

      const user = await getOrCreateUser(
        userId,
        (msg.user_name as string) ?? userId,
        context.teamId
      );

      if (user.onboardingStatus !== "ready") {
        await client.chat.postMessage({
          channel: message.channel,
          text: getConnectGoogleMessage(userId),
          blocks: getConnectGoogleBlocks(userId) as unknown as Array<Block | KnownBlock>,
        });
        return;
      }

      const post = await client.chat.postMessage({
        channel: message.channel,
        text: "thinking...",
      });
      placeholder = { ts: post.ts ?? undefined };
      // eslint-disable-next-line no-console
      console.log(`${HANDLER_LOG} User ensured in Firestore`);

      const receiptUrls: string[] = [];

      const files = msg.files as Array<{
        id?: string;
        name?: string;
        mimetype?: string;
        url_private?: string;
        url_private_download?: string;
      }> | undefined;

      if (Array.isArray(files) && files.length > 0) {
        const imageFiles = files.filter((f) =>
          f.mimetype?.startsWith("image/")
        );
        // eslint-disable-next-line no-console
        console.log(`${HANDLER_LOG} Attachments: ${files.length} total, ${imageFiles.length} image(s)`);

        if (imageFiles.length > 0) {
          const token = process.env.SLACK_BOT_TOKEN;

          const downloadedImages = await Promise.all(
            imageFiles.map(async (file) => {
              if (!token) return null;
              const fallbackUrl = file.url_private_download || file.url_private;
              if (!fallbackUrl) return null;

              // Cloud Run reliability: ask Slack Web API for a fresh, authorized download URL
              // rather than trusting the event payload URL alone.
              let url = fallbackUrl;
              if (file.id) {
                try {
                  const info = (await (client as unknown as {
                    files: { info: (args: { file: string }) => Promise<unknown> };
                  }).files.info({ file: file.id })) as {
                    ok?: boolean;
                    file?: { url_private_download?: string; url_private?: string };
                  };
                  const apiUrl =
                    info?.file?.url_private_download || info?.file?.url_private;
                  if (apiUrl) url = apiUrl;
                } catch (infoErr) {
                  // eslint-disable-next-line no-console
                  console.log(
                    `${HANDLER_LOG} files.info failed for file id=${file.id}, falling back to event url:`,
                    infoErr
                  );
                }
              }

              const res = await fetchSlackFileWithAuth(url, token);

              if (!res.ok) return null;

              const contentType = res.headers.get("content-type") ?? undefined;
              const contentLength = res.headers.get("content-length") ?? undefined;
              const finalUrl = (res as unknown as { url?: string }).url;

              const buffer = Buffer.from(await res.arrayBuffer());

              const headerHex = buffer.subarray(0, 16).toString("hex");
              const isImageHeader = looksLikePng(buffer) || looksLikeJpeg(buffer);
              const isImageContentType = (contentType ?? file.mimetype ?? "").startsWith(
                "image/"
              );

              // eslint-disable-next-line no-console
              console.log(
                `${HANDLER_LOG} Downloaded file id=${file.id ?? "?"} name=${file.name ?? "?"} status=${res.status} content-type=${contentType ?? "?"} content-length=${contentLength ?? "?"} bytes=${buffer.length} headerHex=${headerHex} url=${finalUrl ?? url}`
              );

              // If Slack auth/redirect issues happen on Cloud Run, we can end up with HTML (200 OK).
              // Reject uploads that don't look like an image to avoid poisoning GCS with HTML.
              if (!isImageContentType || !isImageHeader) {
                // eslint-disable-next-line no-console
                console.log(
                  `${HANDLER_LOG} Skipping upload: not a valid image payload (content-type=${contentType ?? file.mimetype ?? "?"} headerHex=${headerHex})`
                );
                return null;
              }

              return {
                buffer,
                filename: file.name || "receipt.jpg",
                mimeType: contentType || file.mimetype || "image/jpeg",
              };
            })
          );

          const validImages = downloadedImages.filter(
            (img): img is NonNullable<typeof img> => img !== null
          );
          if (downloadedImages.length !== validImages.length) {
            // eslint-disable-next-line no-console
            console.log(`${HANDLER_LOG} Image download: ${validImages.length}/${downloadedImages.length} succeeded`);
          }

          if (validImages.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`${HANDLER_LOG} Uploading ${validImages.length} image(s) to GCS…`);
            const urls =
              await uploadMultipleReceiptImages(validImages);
            receiptUrls.push(...urls);
            // eslint-disable-next-line no-console
            console.log(`${HANDLER_LOG} GCS upload done, receiptUrls: ${urls.length}`);
          }
        }
      }

      const messageText = (msg.text as string) ?? "";
      // eslint-disable-next-line no-console
      console.log(`${HANDLER_LOG} Calling handleLLMMessage (text=${messageText.slice(0, 50)}… receiptUrls=${receiptUrls.length})`);

      const updatePlaceholder =
        placeholder?.ts ?
          async (text: string) => {
            await client.chat.update({
              channel: message.channel,
              ts: placeholder!.ts!,
              text,
            });
          }
          : undefined;

      const llmResponse = await handleLLMMessage(
        userId,
        messageText,
        receiptUrls.length > 0 ? receiptUrls : undefined,
        updatePlaceholder
      );

      // eslint-disable-next-line no-console
      console.log(`${HANDLER_LOG} Updating placeholder with response (${llmResponse.length} chars)`);
      try {
        await client.chat.update({
          channel: message.channel,
          ts: placeholder!.ts!,
          text: llmResponse,
        });
      } catch (updateErr) {
        // If update fails, fall back to posting a new message so the user isn't stuck on "thinking..."
        // eslint-disable-next-line no-console
        console.error(`${HANDLER_LOG} chat.update failed, falling back to postMessage:`, updateErr);
        await client.chat.postMessage({
          channel: message.channel,
          text: llmResponse,
        });
      }
      // eslint-disable-next-line no-console
      console.log(`${HANDLER_LOG} Done.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`${HANDLER_LOG} FAILED:`, err);
      logger.error(err);
      try {
        if (placeholder?.ts) {
          await client.chat.update({
            channel: message.channel,
            ts: placeholder.ts,
            text: "Sorry, I ran into an error. Please try again.",
          });
        } else {
          await client.chat.postMessage({
            channel: message.channel,
            text: "Sorry, I ran into an error. Please try again.",
          });
        }
      } catch (postErr) {
        logger.error("Failed to post error fallback:", postErr);
      }
    }
  });
}
