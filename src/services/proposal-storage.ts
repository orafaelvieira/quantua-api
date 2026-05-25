/**
 * Wrapper sobre storage.ts pra paths de proposta comercial.
 *
 * Layout no bucket:
 *   engagements/<engagementId>/proposal-<version>-<hashShort>.pdf
 *
 * Inclui hash curto no path pra debug — versões diferentes da mesma carta
 * não se sobrescrevem; ops pode rebobinar histórico se precisar.
 *
 * Signed URL TTL default: 24h (longa o suficiente pra cliente abrir email
 * e baixar; curta o suficiente pra não ser link permanente).
 */

import crypto from "crypto";
import { uploadFile, getSignedDownloadUrl } from "./storage";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

export interface UploadProposalInput {
  engagementId: string;
  version: string;
  pdfBuffer: Buffer;
}

export interface UploadProposalResult {
  storagePath: string;
  pdfHash: string;
}

export async function uploadProposalPdf(input: UploadProposalInput): Promise<UploadProposalResult> {
  // Hash do binário (NÃO do HTML/letter contentHash — esses são separados).
  // Permite detectar corruption no Spaces ou re-renders idênticos.
  const pdfHash = crypto.createHash("sha256").update(input.pdfBuffer).digest("hex");
  const hashShort = pdfHash.slice(0, 12);
  const safeVersion = input.version.replace(/[^A-Za-z0-9_.-]/g, "_");
  const storagePath = `engagements/${input.engagementId}/proposal-${safeVersion}-${hashShort}.pdf`;

  await uploadFile(input.pdfBuffer, storagePath, "application/pdf");

  return { storagePath, pdfHash };
}

export async function getProposalSignedUrl(
  storagePath: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  return getSignedDownloadUrl(storagePath, ttlSeconds, "application/pdf");
}
