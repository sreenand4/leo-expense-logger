import { Storage } from "@google-cloud/storage";
import path from "path";
import { v4 as uuidv4 } from "uuid";

function getStorageClient(): Storage {
  const credentialsPath = process.env.GCP_CREDENTIALS;
  const projectId = process.env.GCP_PROJECT_ID;

  if (!credentialsPath) throw new Error("GCP_CREDENTIALS is not set");
  if (!projectId) throw new Error("GCP_PROJECT_ID is not set");

  const keyFilename = path.isAbsolute(credentialsPath)
    ? credentialsPath
    : path.resolve(process.cwd(), credentialsPath);

  return new Storage({ keyFilename, projectId });
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
