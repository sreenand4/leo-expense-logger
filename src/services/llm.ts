import Anthropic from "@anthropic-ai/sdk";
import {
  addReceiptUrlsToShoot,
  getActiveShoot,
  getAllShoots,
  getShoot,
  incrementExpenseCount,
  setActiveShoot,
} from "./firestore";
import { postToChannel } from "./slack";
import { appendExpenseRow, getSheetSummary } from "./sheets";

const SYSTEM_PROMPT = `You are Leo, a Giraffe persona slack based assistant here to help Log Expenses On-the-go (get it, LEO). You work for independent photographers while they are on their shoots. You are precise, brief, and never waste the user's time.

---

## What You Do
Help the photographer log shoot expenses and answer questions about their spending/active shoots. They will send expense descriptions, receipt photos, or spending questions.

---

## Slack Formatting (mrkdwn)
Your responses will be shown in Slack.

- For **bold**, use single asterisks: *bold* (NOT **bold**).
- Avoid fancy Markdown features Slack doesn't support consistently.

---

## HARD Slash Command Redirects
- Starting a new shoot → "To start a new shoot, use: /newshoot [shoot name]"
- Wrapping up / finishing / archiving a shoot → "To wrap up a shoot, use: /wrapshoot"

Some actions must be performed using slash commands and only a slash command — you cannot perform these yourself. When you detect the user's intent matches one of the following, do not attempt to execute it. Instead, respond with exactly the redirect message shown.
Trigger phrases to watch for: "new shoot", "start a shoot", "create a shoot", "wrap up", "wrap this", "finish the shoot", "done with this shoot", "archive", "close out the shoot".

## SOFT Slash Command Usage
- Switching to a different shoot → "To switch shoots, use: /setshoot [shoot name]"

These are some actions that are supported by the slash commands, but you can also perform them by calling the respective tools.
If a user indicates an intent to switch shoots (ie "switch to", "change shoot") you should:
1. Call getActiveShoot and getAllShoots first.
2. Extract the destination text from the user's message and match it against shoot names from getAllShoots.
3. Match conservatively (name-based only, no semantic inference):
   - A match requires direct character/token overlap with the destination text.
   - Allow exact, clear prefix, or minor typo match only.
   - Never infer region/country/category relationships.
4. If there is not exactly one safe match, respond with: "Please provide a valid shoot name to switch to. Your options are [list of shoot names - current active shoot if one is active]".
5. If there is exactly one safe, match and it is active, make sure it is not already the result of earlier getActiveShoot call. If it is, respond with "You are already on that shoot. No need to switch." and do not call setActiveShoot.
6. If there is exactly one safe, match and it is active, and it is not already the result of earlier getActiveShoot call, call setActiveShoot with its shootId.
---

## Tool Usage Rules

**Never call tools for:** greetings, small talk, off-topic messages, or slash command redirects. Respond directly.

**Always follow this order when tools are needed:**
1. Start by getting shoot context. For switching intents, call both getActiveShoot and getAllShoots before any write action. For other intents, call getActiveShoot first.
2. If receipt URLs are present, call parseReceiptWithOCR for each URL next.
3. Only then call logExpense, getSheetSummary or setActiveShoot.

---

## Expense Logging

**From text:** Extract merchant, amount, category, and date. Use today's date if none is given. Infer category from context. Default to "Other" only when truly ambiguous.

**From receipt images:**
- Parse every receipt URL with parseReceiptWithOCR before logging anything.
- GOOD result: merchant and amount are clearly identifiable → log the expense, include receiptUrls in the logExpense call.
- BAD result: text is garbled, missing merchant or amount, or nonsensical → do not log. Reply: "That receipt was too unclear to read. Could you retake the photo or type the details?"
- PARTIAL result: some fields readable but amount or merchant is missing → do not guess. State exactly what you could and could not read and ask for a clearer photo of the receipt to re-parse.
- Multiple receipts → log each as a separate expense row.
- Always include receiptUrls in logExpense when images were provided.

**Categories:** Travel · Meals · Gear · Props · Studio · Other

---

## Spending / Overall state Questions
Call respective getActiveShoot, getAllShoots, and getSheetSummary tools to get the real numbers / data and respond with the real numbers / data formatted in plain English. No fluff.

---

## Response Format — Strictly Enforced

**After logging expenses:**
Reply with ONLY a confirmation. One line per expense. No questions, no emojis, no suggestions.
Format: "Logged [Merchant], $[Amount], [Category], [Date] - [Shoot name]."

**After spending questions:**
State only the facts. No commentary.

**For redirects, errors, or clarifications:**
One or two sentences maximum. Be direct.

**For small talk or off-topic:**
One sentence. Warm but brief. Remind them what you're here for if relevant.

---

## Hard Rules
- Never invent expense data.
- Never guess a sheet ID — always get it from getActiveShoot.
- Never call logExpense without first calling getActiveShoot in the same conversation turn.
- Never add follow-up questions after logging ("Got a receipt?", "Anything else?") — wait for the user to continue.`;

const tools: Anthropic.Tool[] = [
  {
    name: "getActiveShoot",
    description:
      "Gets the currently active shoot for the photographer, including the shoot name, Google Sheet ID, and Slack channel ID. Call this first only when you need to log an expense, answer a spending question, or otherwise need the current shoot/sheet—e.g. before logExpense or getSheetSummary. Do not call for greetings or small talk.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "getAllShoots",
    description:
      "Gets all active shoots for the photographer. By active here we mean unarchived shoots. Use this when user asks about multiple shoots, or when switching shoots so you can match the requested destination name safely.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "getSheetSummary",
    description:
      "Gets all expense rows from the Google Sheet for a specific shoot. Use this to answer spending questions.",
    input_schema: {
      type: "object" as const,
      properties: {
        sheetId: {
          type: "string" as const,
          description: "The Google Sheet ID to query",
        },
      },
      required: ["sheetId"],
    },
  },
  {
    name: "setActiveShoot",
    description:
      "Sets the active shoot for the photographer. Use this to switch between different shoots.",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: {
          type: "string" as const,
          description: "The user ID to set the active shoot for",
        },
        shootId: {
          type: "string" as const,
          description: "The unique Shoot document ID representing the destination Shoot object",
        },
      },
      required: ["userId", "shootId"],
    },
  },
  {
    name: "parseReceiptWithOCR",
    description:
      "Parses a receipt image using OCR and returns the extracted text content as markdown. Call this when the user provides a receipt image URL. You must call this before logExpense when an image is present.",
    input_schema: {
      type: "object" as const,
      properties: {
        imageUrl: {
          type: "string" as const,
          description:
            "The publicly accessible URL of the receipt image to parse",
        },
      },
      required: ["imageUrl"],
    },
  },
  {
    name: "logExpense",
    description:
      "Logs a new expense to the active shoot's Google Sheet and increments the expense count. Use this when the user describes an expense or uploads a receipt.",
    input_schema: {
      type: "object" as const,
      properties: {
        sheetId: {
          type: "string" as const,
          description: "The Google Sheet ID to log to",
        },
        shootId: {
          type: "string" as const,
          description:
            "The Firestore shoot document ID, needed to update the expense count",
        },
        merchant: { type: "string" as const },
        amount: { type: "number" as const },
        category: {
          type: "string" as const,
          enum: ["Travel", "Meals", "Gear", "Props", "Studio", "Other"],
        },
        date: {
          type: "string" as const,
          description:
            "ISO date string YYYY-MM-DD. Use today's date if not specified.",
        },
        notes: { type: "string" as const },
        receiptUrls: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Array of public GCS URLs for receipt images associated with this expense. Include all receipt URLs the user provided for this expense.",
        },
      },
      required: ["sheetId", "shootId", "merchant", "amount", "category", "date"],
    },
  },
];

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  userId: string,
  updatePlaceholder?: (text: string) => Promise<void>
): Promise<string> {
  const logPrefix = "[LLM executeTool]";
  console.log(`${logPrefix} ${name} called`, input?.imageUrl ? "(imageUrl present)" : Object.keys(input).filter((k) => input[k] != null).join(", ") || "(no args)");
  try {
    switch (name) {
      case "getActiveShoot": {
        await updatePlaceholder?.("Getting active shoot…");
        const result = await getActiveShoot(userId);
        if (result === null) {
          console.log(`${logPrefix} getActiveShoot -> no active shoot`);
          return "No active shoot found. The user needs to run /newshoot first.";
        }
        console.log(`${logPrefix} getActiveShoot -> success (shoot: ${result.name})`);
        return JSON.stringify(result);
      }
      case "setActiveShoot": {
        await updatePlaceholder?.("Setting active shoot…");
        const shootId = input.shootId as string;
        await setActiveShoot(userId, shootId);
        console.log(`${logPrefix} setActiveShoot -> success (shootId: ${shootId})`);
        return JSON.stringify({ success: true, shootId });
      }
      case "getAllShoots": {
        await updatePlaceholder?.("Getting all shoots…");
        const result = await getAllShoots(userId);
        console.log(`${logPrefix} getAllShoots -> success (${result.length} shoots)`);
        return JSON.stringify(result);
      }
      case "getSheetSummary": {
        await updatePlaceholder?.("Summarizing expense sheet…");
        const sheetId = input.sheetId as string;
        const result = await getSheetSummary(userId, sheetId);
        console.log(`${logPrefix} getSheetSummary -> success (${result.length} rows)`);
        return JSON.stringify(result);
      }
      case "parseReceiptWithOCR": {
        await updatePlaceholder?.("Processing image…");
        const imageUrl = input.imageUrl as string;
        console.log(`${logPrefix} parseReceiptWithOCR -> fetching image from GCS: ${imageUrl.slice(0, 80)}…`);

        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          console.log(`${logPrefix} parseReceiptWithOCR -> failed to fetch image: ${imageResponse.status}`);
          return JSON.stringify({
            error: `Failed to fetch image: ${imageResponse.status}`,
          });
        }
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const contentType =
          imageResponse.headers.get("content-type") || "image/jpeg";
        const filename = imageUrl.split("/").pop() || "receipt.jpg";
        // eslint-disable-next-line no-console
        console.log(`${logPrefix} parseReceiptWithOCR -> image fetched: ${imageBuffer.length} bytes, contentType=${contentType}, filename=${filename}`);

        const FormData = (await import("form-data")).default;
        const form = new FormData();
        form.append("files", imageBuffer, {
          filename,
          contentType,
        });
        form.append("strategy", "hi_res");
        form.append("output_format", "application/json");

        console.log(`${logPrefix} parseReceiptWithOCR -> building multipart body…`);
        const formBuffer = (form as { getBuffer: () => Buffer }).getBuffer();
        console.log(`${logPrefix} parseReceiptWithOCR -> multipart size: ${formBuffer.length} bytes`);
        const formHeaders = {
          "unstructured-api-key":
            process.env.UNSTRUCTURED_API_KEY ?? "",
          ...form.getHeaders(),
          "Content-Length": String(formBuffer.length),
        };
        const unstructuredUrl =
          "https://api.unstructuredapp.io/general/v0/general";
        // eslint-disable-next-line no-console
        console.log(`${logPrefix} parseReceiptWithOCR -> calling Unstructured API (body ${formBuffer.length} bytes, strategy=hi_res)`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);

        let unstructuredResponse: Response;
        try {
          unstructuredResponse = await fetch(unstructuredUrl, {
            method: "POST",
            headers: formHeaders,
            body: formBuffer as unknown as BodyInit,
            signal: controller.signal,
          });
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          const isTimeout =
            fetchErr instanceof Error && fetchErr.name === "AbortError";
          console.log(
            `${logPrefix} parseReceiptWithOCR -> ${isTimeout ? "timed out after 60s" : "fetch failed"}:`,
            fetchErr
          );
          return JSON.stringify({
            error: isTimeout
              ? "Receipt processing took too long. Please try again with a clearer image."
              : `Receipt processing failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          });
        }
        clearTimeout(timeoutId);

        if (!unstructuredResponse.ok) {
          const errText = await unstructuredResponse.text();
          console.log(
            `${logPrefix} parseReceiptWithOCR -> Unstructured API error: ${unstructuredResponse.status}`,
            errText
          );
          return JSON.stringify({
            error: `Unstructured API error: ${unstructuredResponse.status} — ${errText}`,
          });
        }

        const elements = (await unstructuredResponse.json()) as Array<{
          type: string;
          text: string;
        }>;
        console.log(`${logPrefix} parseReceiptWithOCR -> Unstructured API success: ${elements?.length ?? 0} elements`);

        const markdown = elements
          .filter((el) => el.text && el.text.trim().length > 0)
          .map((el) => {
            if (el.type === "Title") return `## ${el.text}`;
            if (el.type === "Table") return `\`\`\`\n${el.text}\n\`\`\``;
            return el.text;
          })
          .join("\n\n");

        const out = markdown || "No text could be extracted from this receipt image.";
        console.log(`${logPrefix} parseReceiptWithOCR -> success (markdown length ${out.length})`);
        console.log(`${logPrefix} parseReceiptWithOCR -> extracted content:\n${out}`);
        return out;
      }
      case "logExpense": {
        await updatePlaceholder?.("💰 Saving expense to sheet…");
        const sheetId = input.sheetId as string;
        const shootId = input.shootId as string;
        const merchant = input.merchant as string;
        const amount = Number(input.amount);
        const category = input.category as string;
        const date = input.date as string;
        const notes = (input.notes as string) ?? "";
        const receiptUrls = (input.receiptUrls as string[]) ?? [];
        const receiptUrl = receiptUrls.length > 0 ? receiptUrls.join(", ") : "";

        await appendExpenseRow(userId, sheetId, {
          date,
          merchant,
          amount,
          category,
          notes,
          receiptUrl,
        });
        incrementExpenseCount(shootId);
        if (receiptUrls.length > 0) {
          addReceiptUrlsToShoot(shootId, receiptUrls);
        }

        // Notify the shoot's Slack channel so the user sees the update there
        try {
          const shoot = await getShoot(shootId);
          if (shoot?.slackChannelId) {
            const amountStr = typeof amount === "number" ? amount.toFixed(2) : String(amount);
            const fallbackText = `Expense logged: ${merchant}, $${amountStr}, ${category}, ${date}`;
            const blocks = [
              {
                type: "section" as const,
                text: {
                  type: "mrkdwn" as const,
                  text: `💰 *Expense logged to ${shoot.name}*\n${merchant} — $${amountStr} · ${category} · ${date}${notes ? `\n_${notes}_` : ""}`,
                },
              },
            ];
            await postToChannel(
              shoot.slackChannelId,
              userId,
              blocks,
              fallbackText
            );
            console.log(`${logPrefix} logExpense -> posted to shoot channel ${shoot.slackChannelId}`);
          }
        } catch (postErr) {
          console.warn(`${logPrefix} logExpense -> failed to post to shoot channel:`, postErr);
        }

        console.log(`${logPrefix} logExpense -> success (${merchant} $${amount})`);
        return JSON.stringify({
          success: true,
          merchant,
          amount,
          receiptUrls,
        });
      }
      default:
        console.log(`${logPrefix} ${name} -> unknown tool`);
        return "Unknown tool";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${logPrefix} ${name} -> threw:`, message);
    return JSON.stringify({ error: message });
  }
}

const LOG_PREFIX = "[LLM]";

function toSlackMrkdwn(text: string): string {
  // Slack mrkdwn uses *bold*, not **bold**.
  // Keep it conservative: only normalize double-asterisk bold.
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

export async function handleLLMMessage(
  userId: string,
  messageText: string,
  receiptUrls?: string[],
  updatePlaceholder?: (text: string) => Promise<void>
): Promise<string> {
  console.log(`${LOG_PREFIX} handleLLMMessage start — userId=${userId} receiptUrls=${receiptUrls?.length ?? 0} text=${(messageText || "").slice(0, 80)}${(messageText?.length ?? 0) > 80 ? "…" : ""}`);

  const client = new Anthropic();

  const userContent: Anthropic.MessageParam["content"] = [];

  if (receiptUrls && receiptUrls.length > 0) {
    const urlList = receiptUrls
      .map((url, i) => `Receipt ${i + 1}: ${url}`)
      .join("\n");
    userContent.push({
      type: "text",
      text: `${messageText || "I have uploaded receipt photos."}\n\nReceipt image URLs:\n${urlList}\n\nPlease parse each receipt using the parseReceiptWithOCR tool before logging expenses.`,
    });
  } else {
    userContent.push({
      type: "text",
      text: messageText || "Hello",
    });
  }

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];

  try {
    let iteration = 0;
    while (true) {
      iteration += 1;
      console.log(`${LOG_PREFIX} --- loop iteration ${iteration} ---`);

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      const contentSummary = response.content
        .map((b) => (b.type === "text" ? "text" : b.type === "tool_use" ? `tool_use:${(b as { name: string }).name}` : b.type))
        .join(", ");
      console.log(`${LOG_PREFIX} Claude response: stop_reason=${response.stop_reason} content=[${contentSummary}]`);

      if (response.stop_reason === "end_turn") {
        const textBlock = response.content.find((b) => b.type === "text");
        const text =
          textBlock && "text" in textBlock
            ? (textBlock as { text: string }).text
            : undefined;
        const finalText = toSlackMrkdwn(text ?? "Done.");
        console.log(`${LOG_PREFIX} -> FINAL RESPONSE to user (${finalText.length} chars):`, finalText.slice(0, 120) + (finalText.length > 120 ? "…" : ""));
        return finalText;
      }

      if (response.stop_reason === "tool_use") {
        const toolBlocks = response.content.filter((b) => b.type === "tool_use") as Array<{ name: string; id: string; input: unknown }>;
        const toolNames = toolBlocks.map((b) => b.name).join(", ");
        console.log(`${LOG_PREFIX} -> TOOL CALL (${toolBlocks.length}): ${toolNames}`);

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type === "tool_use") {
            const result = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              userId,
              updatePlaceholder
            );
            const resultPreview = result.length > 100 ? `${result.slice(0, 100)}…` : result;
            console.log(`${LOG_PREFIX} tool result ${block.name}:`, resultPreview);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result,
            });
          }
        }

        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
        console.log(`${LOG_PREFIX} -> REPROMPT with ${toolResults.length} tool result(s), continuing loop`);
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} FAILED:`, err);
    return "Sorry, something went wrong. Please try again.";
  }
}
