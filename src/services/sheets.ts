import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import {
  getDriveFolderId,
  getGoogleRefreshToken,
  setDriveFolderId,
} from "./firestore";

// Sheets API v4: https://developers.google.com/workspace/sheets/api/reference/rest
// Drive API v3:  https://developers.google.com/workspace/drive/api/reference/rest/v3

async function getAuthClientForUser(userId: string): Promise<OAuth2Client> {
  const refreshToken = await getGoogleRefreshToken(userId);

  if (!refreshToken) {
    throw new Error(
      `No Google refresh token found for user ${userId}. User needs to complete OAuth.`
    );
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    `${process.env.SERVER_BASE_URL}/auth/google/callback`
  );

  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function getSheetsClient(auth: OAuth2Client) {
  return google.sheets({ version: "v4", auth });
}

function getDriveClient(auth: OAuth2Client) {
  return google.drive({ version: "v3", auth });
}

const HEADER_ROW = [
  "Date",
  "Merchant",
  "Amount",
  "Category",
  "Notes",
  "Receipt URL",
];

export interface ExpenseRow {
  date: string;
  merchant: string;
  amount: number;
  category: string;
  notes: string;
  receiptUrl: string;
}

// Per-process cache of Drive folder IDs by Slack user ID.
const driveFolderCache = new Map<string, string>();

async function getOrCreateDriveFolderForUser(
  userId: string,
  auth: OAuth2Client
): Promise<string | null> {
  try {
    const cachedId = driveFolderCache.get(userId);
    if (cachedId) return cachedId;

    const existingId = await getDriveFolderId(userId);
    if (existingId) {
      driveFolderCache.set(userId, existingId);
      return existingId;
    }

    const drive = getDriveClient(auth);
    const createRes = await drive.files.create({
      requestBody: {
        name: "Leo’s workspace",
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id",
    });

    const folderId = createRes.data.id ?? null;
    if (!folderId) return null;

    await setDriveFolderId(userId, folderId);
    driveFolderCache.set(userId, folderId);
    return folderId;
  } catch (err) {
    console.error(
      "Failed to get or create Drive folder for user; falling back to env folder if set:",
      err
    );
    return null;
  }
}

/**
 * Create a new Google Spreadsheet in the target Drive folder and add header row.
 * Drive:  files.create (POST /drive/v3/files) with spreadsheet mime type.
 * Sheets: spreadsheets.values.update (PUT .../values/{range}).
 */
export async function createShootSheet(
  userId: string,
  shootName: string
): Promise<{ sheetId: string; sheetUrl: string }> {
  try {
    const auth = await getAuthClientForUser(userId);
    const title = `${shootName} — Expenses`;
    const drive = getDriveClient(auth);
    const sheets = getSheetsClient(auth);

    // Create sheet directly in the target folder to avoid extra move calls.
    let folderId = await getOrCreateDriveFolderForUser(userId, auth);
    if (!folderId) {
      const envFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
      if (envFolderId) {
        folderId = envFolderId;
      }
    }
    const createRes = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        ...(folderId ? { parents: [folderId] } : {}),
      },
      fields: "id",
    });

    const sheetId = createRes.data.id;
    if (!sheetId) {
      throw new Error("Drive API did not return a spreadsheet ID.");
    }

    // Sheets API v4: spreadsheets.values.update — sets values in a range
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "A1:F1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADER_ROW] },
    });

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

    return { sheetId, sheetUrl };
  } catch (error: unknown) {
    const err = error as { response?: { data?: unknown } };
    console.error(
      "Sheets 403 full error:",
      JSON.stringify(err?.response?.data, null, 2)
    );
    throw error;
  }
}

/**
 * Append one expense row. Sheets API v4: spreadsheets.values.append (POST .../values/{range}:append).
 */
export async function appendExpenseRow(
  userId: string,
  sheetId: string,
  expense: ExpenseRow
): Promise<void> {
  const auth = await getAuthClientForUser(userId);
  const sheets = getSheetsClient(auth);
  const row = [
    expense.date,
    expense.merchant,
    String(expense.amount),
    expense.category,
    expense.notes,
    expense.receiptUrl ?? "",
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "A:F",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

/**
 * Read all data rows (skip header). Sheets API v4: spreadsheets.values.get (GET .../values/{range}).
 */
export async function getSheetSummary(
  userId: string,
  sheetId: string
): Promise<ExpenseRow[]> {
  const auth = await getAuthClientForUser(userId);
  const sheets = getSheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "A:F",
  });

  const rows = res.data.values ?? [];
  if (rows.length <= 1) return [];

  const result: ExpenseRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const amount = Number(row[2]);
    result.push({
      date: (row[0] ?? "").toString(),
      merchant: (row[1] ?? "").toString(),
      amount: Number.isFinite(amount) ? amount : 0,
      category: (row[3] ?? "").toString(),
      notes: (row[4] ?? "").toString(),
      receiptUrl: (row[5] ?? "").toString(),
    });
  }
  return result;
}
