import { App, Block, KnownBlock } from "@slack/bolt";
import { getOrCreateUser } from "../services/firestore";
import { handleLLMMessage } from "../services/llm";
import { uploadMultipleReceiptImages } from "../services/storage";
import { getConnectGoogleBlocks, getConnectGoogleMessage } from "../utils/slack";

const HANDLER_LOG = "[Handler]";

export function registerMessageHandler(app: App): void {
  app.message(async ({ message, client, logger }) => {
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
        (msg.user_name as string) ?? userId
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
              if (!file.url_private || !token) return null;

              const res = await fetch(file.url_private, {
                headers: { Authorization: `Bearer ${token}` },
              });

              if (!res.ok) return null;

              const buffer = Buffer.from(await res.arrayBuffer());
              return {
                buffer,
                filename: file.name || "receipt.jpg",
                mimeType: file.mimetype || "image/jpeg",
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
      await client.chat.update({
        channel: message.channel,
        ts: placeholder!.ts!,
        text: llmResponse,
      });
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
