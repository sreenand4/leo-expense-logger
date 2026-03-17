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

const DEFAULT_SHEET_NAME = "Sheet1";
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

async function getOrCreateDriveFolderForUser(
  userId: string,
  auth: OAuth2Client
): Promise<string | null> {
  try {
    const existingId = await getDriveFolderId(userId);
    if (existingId) return existingId;

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
    return folderId;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "Failed to get or create Drive folder for user; falling back to env folder if set:",
      err
    );
    return null;
  }
}

/**
 * Create a new Google Spreadsheet, add header row, and share as "anyone with link" writer.
 * Sheets: spreadsheets.create (POST /v4/spreadsheets), values.update (PUT .../values/{range}).
 * Drive:  permissions.create (POST /drive/v3/files/{fileId}/permissions).
 */
export async function createShootSheet(
  userId: string,
  shootName: string
): Promise<{ sheetId: string; sheetUrl: string }> {
  try {
    const auth = await getAuthClientForUser(userId);
    const title = `${shootName} — Expenses`;

    // Sheets API v4: spreadsheets.create — request body is Spreadsheet (properties, sheets)
    const createRes = await getSheetsClient(auth).spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{ properties: { title: DEFAULT_SHEET_NAME } }],
      },
    });

    const sheetId = createRes.data.spreadsheetId;
    if (!sheetId) {
      throw new Error("Sheets API did not return a spreadsheet ID.");
    }

    // Move sheet into the user's dedicated Drive folder if available,
    // otherwise fall back to the shared folder from env.
    let folderId = await getOrCreateDriveFolderForUser(userId, auth);
    if (!folderId) {
      const envFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
      if (envFolderId) {
        folderId = envFolderId;
      }
    }
    if (folderId) {
      const fileData = await getDriveClient(auth).files.get({
        fileId: sheetId,
        fields: "parents",
      });
      const previousParents = fileData.data.parents?.join(",") ?? "";
      await getDriveClient(auth).files.update({
        fileId: sheetId,
        addParents: folderId,
        removeParents: previousParents,
        fields: "id, parents",
      });
    }

    // Sheets API v4: spreadsheets.values.update — sets values in a range
    await getSheetsClient(auth).spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${DEFAULT_SHEET_NAME}!A1:F1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADER_ROW] },
    });

    // Drive API v3: permissions.create — request body is Permission (role, type)
    await getDriveClient(auth).permissions.create({
      fileId: sheetId,
      requestBody: { role: "writer", type: "anyone" },
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
  const row = [
    expense.date,
    expense.merchant,
    String(expense.amount),
    expense.category,
    expense.notes,
    expense.receiptUrl ?? "",
  ];

  await getSheetsClient(auth).spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${DEFAULT_SHEET_NAME}!A:F`,
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
  const res = await getSheetsClient(auth).spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${DEFAULT_SHEET_NAME}!A:F`,
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
