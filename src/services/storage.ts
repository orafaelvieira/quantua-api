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
  mimeType: string,
  metadata?: Record<string, string>,
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
      Metadata: metadata,
    })
  );
  return key;
}

/** Download com os METADADOS do objeto (ex.: ETag da CVM gravado no arquivamento). */
export async function downloadFileComMeta(
  key: string,
): Promise<{ buffer: Buffer; metadata: Record<string, string> }> {
  const response = await getClient().send(
    new GetObjectCommand({ Bucket: env.spaces.bucket, Key: key })
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), metadata: (response.Metadata ?? {}) as Record<string, string> };
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
  /**
   * Nome do arquivo COMO O ANALISTA VÊ (10/08/2026, pedido do dono: "quero que
   * todos os arquivos baixem corretamente com a extensão"). Sem isto a URL
   * assinada devolve a chave do storage: o navegador abria o PDF numa aba (não
   * baixava) e o CSV/Excel caía na pasta como arquivo SEM EXTENSÃO. Com
   * Content-Disposition: attachment + filename, todo formato baixa com o nome
   * certo, na pasta de downloads escolhida pelo analista no navegador.
   */
  nomeArquivo?: string,
): Promise<string> {
  if (storagePath.startsWith("local:")) {
    const base64 = storagePath.replace("local:", "");
    return `data:${mimeType};base64,${base64}`;
  }
  if (!env.spaces.enabled) {
    throw new Error("Storage não configurado (env.spaces.enabled = false)");
  }
  // RFC 5987: nome ASCII para clientes antigos + filename* UTF-8 (acento no
  // nome do documento é regra, não exceção, em Data room brasileira).
  const disposicao = nomeArquivo
    ? `attachment; filename="${nomeArquivo.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(nomeArquivo)}`
    : undefined;
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket: env.spaces.bucket,
      Key: storagePath,
      ...(disposicao ? { ResponseContentDisposition: disposicao } : {}),
      ...(mimeType !== "application/octet-stream" ? { ResponseContentType: mimeType } : {}),
    }),
    { expiresIn: ttlSeconds },
  );
}

/** MIME pela extensão do NOME do documento — o storage guarda tudo como
 *  octet-stream, e é o content-type que decide se o navegador abre ou baixa. */
export function mimeDoNome(nome: string): string {
  const ext = (nome.split(".").pop() ?? "").toLowerCase();
  const mapa: Record<string, string> = {
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    xls: "application/vnd.ms-excel",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
  };
  return mapa[ext] ?? "application/octet-stream";
}
