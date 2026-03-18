import { Firestore, FieldValue, Timestamp } from "@google-cloud/firestore";

function getDb(): Firestore {
  const credentials = process.env.GCP_CREDENTIALS;
  const projectId = process.env.GCP_PROJECT_ID;

  if (!projectId) throw new Error("GCP_PROJECT_ID is not set");

  // If credentials are not provided, fall back to Application Default Credentials (ADC).
  // This is the preferred setup on Cloud Run (attach a service account with the right IAM).
  if (!credentials || credentials.trim().length === 0) {
    return new Firestore({ projectId });
  }

  // Support both JSON-key-in-env (Cloud Run) and file path (local dev).
  if (credentials.trim().startsWith("{")) {
    const parsed = JSON.parse(credentials);
    return new Firestore({ projectId, credentials: parsed });
  }

  return new Firestore({ projectId, keyFilename: credentials });
}

// --- COLLECTIONS ---

const USERS_COLLECTION = "users";
const SHOOTS_COLLECTION = "shoots";
const INSTALLATIONS_COLLECTION = "installations";

// --- TYPES ---

export interface User {
  id: string;
  slackUserId: string;
  workspaceId: string | null;
  displayName: string;
  activeShootId: string | null;
  onboardingStatus: "pending_google" | "ready";
  googleRefreshToken: string | null;
  connectedAt: Date;
  driveFolderId: string | null;
}

export interface Shoot {
  id: string;
  name: string;
  slackChannelId: string;
  googleSheetId: string;
  status: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  totalExpenses: number;
  userId: string;
  receiptUrls: string[];
}

interface UserDoc {
  slackUserId: string;
  workspaceId?: string | null;
  displayName: string;
  activeShootId: string | null;
  onboardingStatus?: "pending_google" | "ready";
  googleRefreshToken?: string | null;
  connectedAt: Timestamp;
  driveFolderId?: string | null;
}

interface ShootDoc {
  name: string;
  slackChannelId: string;
  googleSheetId: string;
  status: "active" | "archived";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
  totalExpenses: number;
  userId: string;
  receiptUrls?: string[];
}

interface InstallationDoc {
  workspaceId: string;
  workspaceName: string;
  botToken: string;
  botUserId: string;
  installedBy: string;
  installedAt: Timestamp;
}

function toUser(id: string, d: UserDoc): User {
  return {
    id,
    slackUserId: d.slackUserId,
    workspaceId: d.workspaceId ?? null,
    displayName: d.displayName,
    activeShootId: d.activeShootId ?? null,
    onboardingStatus: d.onboardingStatus ?? "pending_google",
    googleRefreshToken: d.googleRefreshToken ?? null,
    connectedAt: d.connectedAt?.toDate?.() ?? new Date(),
    driveFolderId: d.driveFolderId ?? null,
  };
}

function toShoot(id: string, d: ShootDoc): Shoot {
  return {
    id,
    name: d.name,
    slackChannelId: d.slackChannelId,
    googleSheetId: d.googleSheetId,
    status: d.status,
    createdAt: d.createdAt?.toDate?.() ?? new Date(),
    updatedAt: d.updatedAt?.toDate?.() ?? new Date(),
    archivedAt: d.archivedAt?.toDate?.() ?? null,
    totalExpenses: d.totalExpenses ?? 0,
    userId: d.userId,
    receiptUrls: d.receiptUrls ?? [],
  };
}

// --- USER FUNCTIONS ---

// In-memory cache of the user's active shoot (or null if none), keyed by slackUserId.
// This is per-process and best-effort; Firestore remains the source of truth.
const activeShootCache = new Map<string, Shoot | null>();

/**
 * Get existing user by slackUserId or create with the given fields. Document ID is slackUserId.
 */
export async function getOrCreateUser(
  slackUserId: string,
  displayName: string,
  workspaceId?: string
): Promise<User> {
  const ref = getDb().collection(USERS_COLLECTION).doc(slackUserId);
  const snap = await ref.get();
  if (snap.exists) {
    const existing = snap.data() as UserDoc;
    const updates: Partial<UserDoc> = {};

    if (workspaceId && !existing.workspaceId) {
      updates.workspaceId = workspaceId;
    }
    if (
      displayName &&
      (!existing.displayName || existing.displayName === slackUserId)
    ) {
      updates.displayName = displayName;
    }

    if (Object.keys(updates).length > 0) {
      await ref.set(updates, { merge: true });
      return toUser(snap.id, { ...existing, ...updates });
    }

    return toUser(snap.id, existing);
  }
  const now = Timestamp.now();
  const newData: UserDoc = {
    slackUserId,
    workspaceId: workspaceId ?? null,
    displayName,
    activeShootId: null,
    onboardingStatus: "pending_google",
    googleRefreshToken: null,
    connectedAt: now,
    driveFolderId: null,
  };
  await ref.set(newData);
  return toUser(slackUserId, newData);
}

/**
 * Fetch user by slackUserId. Returns null if not found.
 */
export async function getUser(slackUserId: string): Promise<User | null> {
  const snap = await getDb()
    .collection(USERS_COLLECTION)
    .doc(slackUserId)
    .get();
  if (!snap.exists) return null;
  return toUser(snap.id, snap.data() as UserDoc);
}

/**
 * Update only the googleRefreshToken field on the user document.
 */
export async function setGoogleRefreshToken(
  userId: string,
  refreshToken: string
): Promise<void> {
  await getDb()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .update({ googleRefreshToken: refreshToken });
}

/**
 * Update only the onboardingStatus field on the user document.
 */
export async function setOnboardingStatus(
  userId: string,
  status: "pending_google" | "ready"
): Promise<void> {
  await getDb()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .update({ onboardingStatus: status });
}

/**
 * Get the user's Google refresh token. Returns null if missing or not set.
 */
export async function getGoogleRefreshToken(
  userId: string
): Promise<string | null> {
  const snap = await getDb()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .get();
  if (!snap.exists) return null;
  const data = snap.data() as UserDoc;
  return data.googleRefreshToken ?? null;
}

/**
 * Get the user's dedicated Drive folder ID used for storing shoot spreadsheets.
 * Returns null if missing or not set.
 */
export async function getDriveFolderId(userId: string): Promise<string | null> {
  const snap = await getDb()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .get();
  if (!snap.exists) return null;
  const data = snap.data() as UserDoc;
  return data.driveFolderId ?? null;
}

/**
 * Set the user's dedicated Drive folder ID used for storing shoot spreadsheets.
 */
export async function setDriveFolderId(
  userId: string,
  folderId: string
): Promise<void> {
  await getDb()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .set({ driveFolderId: folderId }, { merge: true });
}

// --- SLACK INSTALLATION FUNCTIONS ---

export async function saveSlackInstallation(
  installation: InstallationDoc
): Promise<void> {
  const db = getDb();
  await db
    .collection(INSTALLATIONS_COLLECTION)
    .doc(installation.workspaceId)
    .set(installation);
}

export async function getSlackInstallation(
  workspaceId: string
): Promise<InstallationDoc | null> {
  const db = getDb();
  const snap = await db
    .collection(INSTALLATIONS_COLLECTION)
    .doc(workspaceId)
    .get();
  if (!snap.exists) return null;
  return snap.data() as InstallationDoc;
}

// --- SHOOT FUNCTIONS ---

/**
 * Create a new shoot document. Returns the new document ID.
 */
export async function createShoot(
  name: string,
  slackChannelId: string,
  googleSheetId: string,
  userId: string
): Promise<string> {
  const ref = getDb().collection(SHOOTS_COLLECTION).doc();
  const now = Timestamp.now();
  await ref.set({
    name,
    slackChannelId,
    googleSheetId,
    userId,
    status: "active",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    totalExpenses: 0,
    receiptUrls: [],
  });
  return ref.id;
}

/**
 * Get the active shoot for the user (from user's activeShootId). Returns null if none set or shoot not found.
 */
export async function getActiveShoot(userId: string): Promise<Shoot | null> {
  const cached = activeShootCache.get(userId);
  if (cached !== undefined) {
    return cached;
  }

  const userSnap = await getDb()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .get();
  if (!userSnap.exists) {
    activeShootCache.set(userId, null);
    return null;
  }
  const data = userSnap.data() as UserDoc;
  const activeShootId = data.activeShootId ?? null;
  if (!activeShootId) {
    activeShootCache.set(userId, null);
    return null;
  }

  const shootSnap = await getDb()
    .collection(SHOOTS_COLLECTION)
    .doc(activeShootId)
    .get();
  if (!shootSnap.exists) {
    activeShootCache.set(userId, null);
    return null;
  }
  const shoot = toShoot(shootSnap.id, shootSnap.data() as ShootDoc);
  activeShootCache.set(userId, shoot);
  return shoot;
}

/**
 * Get a shoot by ID. Returns null if not found.
 */
export async function getShoot(shootId: string): Promise<Shoot | null> {
  const shootSnap = await getDb()
    .collection(SHOOTS_COLLECTION)
    .doc(shootId)
    .get();
  if (!shootSnap.exists) return null;
  return toShoot(shootSnap.id, shootSnap.data() as ShootDoc);
}

/**
 * Set the user's active shoot and update the shoot's updatedAt.
 */
export async function setActiveShoot(
  userId: string,
  shootId: string
): Promise<void> {
  const userRef = getDb().collection(USERS_COLLECTION).doc(userId);
  await userRef.set({ activeShootId: shootId }, { merge: true });
  const shootRef = getDb().collection(SHOOTS_COLLECTION).doc(shootId);
  const shootSnap = await shootRef.get();
  if (shootSnap.exists) {
    const shoot = toShoot(shootSnap.id, shootSnap.data() as ShootDoc);
    activeShootCache.set(userId, shoot);
  } else {
    activeShootCache.set(userId, null);
  }
  await shootRef.update({ updatedAt: Timestamp.now() });
}

/**
 * Clear the user's active shoot.
 */
export async function clearActiveShoot(userId: string): Promise<void> {
  const userRef = getDb().collection(USERS_COLLECTION).doc(userId);
  await userRef.set({ activeShootId: null }, { merge: true });
  activeShootCache.set(userId, null);
}

/**
 * Return all shoots for the user where status is "active".
 */
export async function getAllShoots(userId: string): Promise<Shoot[]> {
  const snapshot = await getDb()
    .collection(SHOOTS_COLLECTION)
    .where("userId", "==", userId)
    .where("status", "==", "active")
    .get();
  return snapshot.docs.map((doc) => toShoot(doc.id, doc.data() as ShootDoc));
}

/**
 * Return all shoots for the user (active and archived). Used for the dashboard.
 */
export async function getAllShootsIncludingArchived(
  userId: string
): Promise<Shoot[]> {
  const snapshot = await getDb()
    .collection(SHOOTS_COLLECTION)
    .where("userId", "==", userId)
    .get();
  return snapshot.docs.map((doc) => toShoot(doc.id, doc.data() as ShootDoc));
}

/**
 * Return true if a shoot with the given name exists for the user (any status).
 */
export async function shootExistsByName(
  name: string,
  userId: string
): Promise<boolean> {
  const snapshot = await getDb()
    .collection(SHOOTS_COLLECTION)
    .where("name", "==", name)
    .where("userId", "==", userId)
    .limit(1)
    .get();
  return !snapshot.empty;
}

/**
 * Archive the shoot and clear user's activeShootId if it pointed to this shoot.
 */
export async function archiveShoot(
  shootId: string,
  userId: string
): Promise<void> {
  const now = Timestamp.now();
  const shootRef = getDb().collection(SHOOTS_COLLECTION).doc(shootId);
  await shootRef.update({
    status: "archived",
    archivedAt: now,
    updatedAt: now,
  });

  const userSnap = await getDb()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .get();
  if (userSnap.exists) {
    const data = userSnap.data() as UserDoc;
    if (data.activeShootId === shootId) {
      await getDb()
        .collection(USERS_COLLECTION)
        .doc(userId)
        .set({ activeShootId: null }, { merge: true });
      activeShootCache.set(userId, null);
    }
  }
}

/**
 * Increment totalExpenses on the shoot document by 1.
 */
export async function incrementExpenseCount(shootId: string): Promise<void> {
  const shootRef = getDb().collection(SHOOTS_COLLECTION).doc(shootId);
  await shootRef.update({
    totalExpenses: FieldValue.increment(1),
  });
}

/**
 * Append receipt image URLs to the shoot document for later cleanup (e.g. delete after 30+ days when archived).
 */
export async function addReceiptUrlsToShoot(
  shootId: string,
  urls: string[]
): Promise<void> {
  if (urls.length === 0) return;
  const shootRef = getDb().collection(SHOOTS_COLLECTION).doc(shootId);
  await shootRef.update({
    receiptUrls: FieldValue.arrayUnion(...urls),
    updatedAt: Timestamp.now(),
  });
}
