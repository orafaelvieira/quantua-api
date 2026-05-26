/**
 * Storage de documentos contratuais (NDA, contrato, anexos) do engagement.
 *
 * Layout no bucket:
 *   engagements/<engagementId>/documents/<docId>-<safeFilename>
 *
 * Hash SHA-256 do binário fica gravado em contractUrls junto com o
 * docId pra detectar corruption futura e dar idempotência.
 *
 * Signed URL TTL default: 24h (suficiente pra cliente abrir email
 * e baixar; curto pra não virar link permanente).
 */

import crypto from "crypto";
import { uploadFile, deleteFile, getSignedDownloadUrl } from "./storage";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

export interface EngagementDocumentEntry {
  id: string;
  label: string;
  storagePath: string;
  hash: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface UploadEngagementDocumentInput {
  engagementId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy: string;
}

export interface UploadEngagementDocumentResult {
  doc: EngagementDocumentEntry;
}

function sanitizeFilename(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export async function uploadEngagementDocument(
  input: UploadEngagementDocumentInput,
): Promise<UploadEngagementDocumentResult> {
  const docId = crypto.randomUUID();
  const safeFilename = sanitizeFilename(input.filename);
  const storagePath = `engagements/${input.engagementId}/documents/${docId}-${safeFilename}`;
  const hash = crypto.createHash("sha256").update(input.buffer).digest("hex");

  await uploadFile(input.buffer, storagePath, input.mimeType);

  return {
    doc: {
      id: docId,
      label: input.filename,
      storagePath,
      hash,
      size: input.buffer.length,
      mimeType: input.mimeType,
      uploadedAt: new Date().toISOString(),
      uploadedBy: input.uploadedBy,
    },
  };
}

export async function deleteEngagementDocument(storagePath: string): Promise<void> {
  await deleteFile(storagePath);
}

export async function getEngagementDocumentSignedUrl(
  storagePath: string,
  mimeType: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  return getSignedDownloadUrl(storagePath, ttlSeconds, mimeType);
}
