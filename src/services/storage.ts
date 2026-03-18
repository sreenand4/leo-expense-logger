import { Storage } from "@google-cloud/storage";
import path from "path";
import { v4 as uuidv4 } from "uuid";

function getStorageClient(): Storage {
  const credentials = process.env.GCP_CREDENTIALS;
  const projectId = process.env.GCP_PROJECT_ID;

  if (!projectId) throw new Error("GCP_PROJECT_ID is not set");

  // If credentials are not provided, fall back to Application Default Credentials (ADC).
  // This is the preferred setup on Cloud Run (attach a service account with the right IAM).
  if (!credentials || credentials.trim().length === 0) {
    return new Storage({ projectId });
  }

  // Support both JSON-key-in-env (Cloud Run) and file path (local dev).
  if (credentials.trim().startsWith("{")) {
    const parsed = JSON.parse(credentials);
    return new Storage({ projectId, credentials: parsed });
  }

  return new Storage({ projectId, keyFilename: credentials });
}

export async function uploadReceiptImage(
  imageBuffer: Buffer,
  originalFilename: string,
  mimeType: string
): Promise<string> {
  try {
    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName) throw new Error("GCS_BUCKET_NAME is not set");

    const ext = path.extname(originalFilename) || ".jpg";
    const filename = `receipts/${uuidv4()}${ext}`;

    const storage = getStorageClient();
    const file = storage.bucket(bucketName).file(filename);

    await file.save(imageBuffer, {
      contentType: mimeType,
      metadata: { cacheControl: "public, max-age=31536000" },
      // Cloud Run reliability: avoid multi-request resumable uploads for buffers.
      resumable: false,
      // Avoid automatic gzip; we want bytes preserved exactly.
      gzip: false,
      validation: "crc32c",
    });

    return `https://storage.googleapis.com/${bucketName}/${filename}`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("uploadReceiptImage error:", err);
    throw err;
  }
}

export async function uploadMultipleReceiptImages(
  images: Array<{ buffer: Buffer; filename: string; mimeType: string }>
): Promise<string[]> {
  return Promise.all(
    images.map((img) =>
      uploadReceiptImage(img.buffer, img.filename, img.mimeType)
    )
  );
}
