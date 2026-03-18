## Leo Expense Logger

Leo is a Slack first assistant that helps photographers track shoot expenses in real time. It connects Slack, Google Drive/Sheets, and Firestore so that messy receipts and ad‑hoc messages become a structured, queryable expense logs.

The heart of the app is an **agentic tool-call loop**: every Slack interaction (slash command, app home event, or DM) is handled by a small, declarative loop that calls out to domain “tools” (Firestore, Google APIs, Slack Web API) step by step, reacting to the results at each turn.

---

### What this project does

- **Slash commands for shoots**: create, select, wrap, and list shoots directly from Slack.
- **Per-user context**: keep track of a user’s active shoot and onboarding state in Firestore.
- **Workspace-aware auth**: handle Slack OAuth once per workspace and store bot tokens per team.
- **Install UX**: simple success/failure landing pages for Slack app installation.

All of this is wired through a single Bolt app in `src/index.ts`, which plugs in commands, handlers, and OAuth routes.

---

### The agentic tool-call loop

Instead of writing large, monolithic handlers, each interaction is modeled as:

1. **Interpret the Slack event**
   - Parse the slash command text or message.
   - Infer intent (e.g. “create shoot”, “set active shoot”, “wrap shoot”).

2. **Plan the next tool call**
   - Decide which domain “tool” to call: Firestore (`getOrCreateUser`, `createShoot`, `setActiveShoot`, etc.), Slack Web API, or Google APIs.

3. **Call the tool and inspect the result**
   - Await a single async call.
   - Check whether the result satisfies the current goal (e.g. “user has an active shoot”, “installation exists for this workspace”).

4. **Decide the next action**
   - Either:
     - **Continue the loop** with another tool call (e.g. create a Drive folder, then a Sheet, then a Firestore shoot), or
     - **Finish** by sending a Slack response / updating the app home.

Each handler is therefore a small **agent** that:

- Has access to a **toolbox** (Firestore helpers in `src/services/firestore.ts`, Slack client, Google integrations).
- Repeatedly **chooses the next tool call** based on the latest state.
- Stops when it has enough information to respond to the user.

This makes it easy to extend behavior: adding a new capability usually means adding a new tool function and one more branch in the loop, rather than rewriting the handler.

---

### Key components

- **Entry point**: `src/index.ts`
  - Loads environment, creates the Bolt `App` with an `authorize` function that looks up workspace-specific tokens from Firestore (`getSlackInstallation`).
  - Registers slash commands and handlers (e.g. `registerNewShootCommand`, `registerWrapShootCommand`, `registerMessageHandler`).
  - Exposes `/healthz` and static assets for install pages.

- **Data layer / tools**: `src/services/firestore.ts`
  - Provides small, composable tool functions like:
    - `getOrCreateUser`, `getUser`, `setOnboardingStatus`
    - `createShoot`, `getActiveShoot`, `setActiveShoot`, `archiveShoot`
    - `incrementExpenseCount`, `addReceiptUrlsToShoot`
    - `saveSlackInstallation`, `getSlackInstallation`
  - These are the primitives the agentic loop uses to reason about state.

- **Slack OAuth**: `src/routes/slackAuth.ts`
  - Handles `/slack/oauth_redirect` using the Slack Web API.
  - On success, persists an installation document via `saveSlackInstallation` and redirects to `/install-success`.

---