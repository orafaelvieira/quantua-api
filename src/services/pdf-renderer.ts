/**
 * PDF renderer via Puppeteer + Chromium serverless-friendly.
 *
 * Estratégia: singleton de Browser lazy-bootado no 1º request, reusado warm
 * em requests subsequentes. Boot inicial ~3-5s; renders subsequentes ~500ms.
 *
 * Em prod (DigitalOcean App Platform / Linux): usa `@sparticuz/chromium`
 * bundled (~50MB stripped, bate em Lambda/serverless).
 * Em dev local: respeita `PUPPETEER_EXECUTABLE_PATH` se setado, senão usa
 * o Chromium do `@sparticuz/chromium` (vai funcionar em macOS/Linux,
 * pode falhar em Windows — neste caso setar `PUPPETEER_EXECUTABLE_PATH`).
 *
 * Lifecycle: Browser vive até SIGTERM/SIGINT. Handler chama `close()` pra
 * cleanup limpo. Sem handler, processo morre e Chromium fica órfão.
 */

import type { Browser, PDFOptions } from "puppeteer-core";

let browserPromise: Promise<Browser> | null = null;
let shutdownHandlerRegistered = false;

async function bootBrowser(): Promise<Browser> {
  // Imports dinâmicos pra evitar carregar @sparticuz/chromium (50MB) em
  // testes/script paths que não vão renderizar PDF.
  const puppeteer = await import("puppeteer-core");
  const chromium = (await import("@sparticuz/chromium")).default;

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
    ? process.env.PUPPETEER_EXECUTABLE_PATH
    : await chromium.executablePath();

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath,
    headless: true,
    defaultViewport: { width: 1280, height: 800 },
  });

  return browser;
}

function registerShutdown(): void {
  if (shutdownHandlerRegistered) return;
  shutdownHandlerRegistered = true;
  const close = async () => {
    if (browserPromise) {
      try {
        const b = await browserPromise;
        await b.close();
      } catch {
        // ignore — process is dying
      }
    }
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    registerShutdown();
    browserPromise = bootBrowser().catch((err) => {
      // Reset promise pra próximo request poder retentar
      browserPromise = null;
      throw err;
    });
  }
  const browser = await browserPromise;
  // Defesa: se Chromium morreu (crash, OOM), reseta singleton.
  if (!browser.connected) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

/**
 * Renderiza um HTML completo em PDF. Retorna Buffer pronto pra upload.
 *
 * `opts` aceita as opções padrão do Puppeteer (format, margin, etc.).
 * Default A4 portrait, sem header/footer (eles vêm no HTML mesmo).
 */
export async function renderHtmlToPdf(
  html: string,
  opts: PDFOptions = {},
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "28mm", right: "22mm", bottom: "28mm", left: "22mm" },
      ...opts,
    });
    return Buffer.from(pdfBytes);
  } finally {
    await page.close().catch(() => {});
  }
}
