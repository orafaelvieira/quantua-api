import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

let s3: S3Client | null = null;

function getClient(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      endpoint: env.spaces.endpoint,
      region: env.spaces.region,
      credentials: { accessKeyId: env.spaces.key, secretAccessKey: env.spaces.secret },
      forcePathStyle: false,
    });
  }
  return s3;
}

export async function uploadFile(
  buffer: Buffer,
  key: string,
  mimeType: string
): Promise<string> {
  if (!env.spaces.enabled) {
    // Sem Spaces configurado: armazena em base64 no campo storagePath
    // Apenas para desenvolvimento local
    return `local:${buffer.toString("base64")}`;
  }
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.spaces.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ACL: "private",
    })
  );
  return key;
}

export async function downloadFile(storagePath: string): Promise<Buffer> {
  if (storagePath.startsWith("local:")) {
    return Buffer.from(storagePath.replace("local:", ""), "base64");
  }
  const response = await getClient().send(
    new GetObjectCommand({ Bucket: env.spaces.bucket, Key: storagePath })
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function deleteFile(storagePath: string): Promise<void> {
  if (!env.spaces.enabled || storagePath.startsWith("local:")) return;
  await getClient().send(
    new DeleteObjectCommand({ Bucket: env.spaces.bucket, Key: storagePath })
  );
}

/**
 * Gera URL pré-assinada (default 5min) para download direto do S3.
 * Para storagePath="local:..." retorna um data URI base64 (apenas dev).
 */
export async function getSignedDownloadUrl(
  storagePath: string,
  ttlSeconds = 300,
  mimeType = "application/octet-stream",
): Promise<string> {
  if (storagePath.startsWith("local:")) {
    const base64 = storagePath.replace("local:", "");
    return `data:${mimeType};base64,${base64}`;
  }
  if (!env.spaces.enabled) {
    throw new Error("Storage não configurado (env.spaces.enabled = false)");
  }
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: env.spaces.bucket, Key: storagePath }),
    { expiresIn: ttlSeconds },
  );
}
