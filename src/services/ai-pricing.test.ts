/**
 * PREÇO DA IA — as armadilhas que fazem o custo mentir.
 *
 * Regra do dono (03/08/2026): "sempre precisaremos ter o custo de tudo que usar
 * IA... quando a Quantua escalar não podemos ser surpreendidos".
 */
import { describe, it, expect } from "vitest";
import { precificarTokens, precificarUnidades, BUSCA_WEB_USD, PRECO_VERSAO } from "./ai-pricing";

describe("token: o preço tem de bater com a tabela do provedor", () => {
  it("Haiku 4.5 a $1/$5 por Mtok", () => {
    const r = precificarTokens("claude-haiku-4-5-20251001", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(r.usdTotal).toBeCloseTo(6, 6);
    expect(r.desconhecido).toBe(false);
  });

  it("Opus 4.8 a $5/$25 por Mtok", () => {
    const r = precificarTokens("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(r.usdTotal).toBeCloseTo(30, 6);
  });

  it("LEITURA de cache custa ~10% do token de entrada — nunca era contada antes", () => {
    const normal = precificarTokens("claude-sonnet-4-6", { inputTokens: 1_000_000 });
    const cache = precificarTokens("claude-sonnet-4-6", { cacheLeituraTokens: 1_000_000 });
    expect(cache.usdTotal).toBeCloseTo(normal.usdTotal * 0.1, 6);
  });

  it("ESCRITA de cache custa MAIS que o token de entrada", () => {
    const normal = precificarTokens("claude-sonnet-4-6", { inputTokens: 1_000_000 });
    const escrita = precificarTokens("claude-sonnet-4-6", { cacheCriacaoTokens: 1_000_000 });
    expect(escrita.usdTotal).toBeGreaterThan(normal.usdTotal);
  });

  it("busca web é cobrada por BUSCA, fora da conta de token", () => {
    const r = precificarTokens("claude-sonnet-4-6", { buscasWeb: 10 });
    expect(r.usdTotal).toBeCloseTo(10 * BUSCA_WEB_USD, 8);
  });
});

describe("modelo sem preço NÃO pode virar custo zero", () => {
  it("devolve desconhecido, não R$ 0 silencioso", () => {
    const r = precificarTokens("claude-modelo-que-ainda-nao-existe", { inputTokens: 5_000_000, outputTokens: 2_000_000 });
    expect(r.desconhecido).toBe(true);
    expect(r.preco).toBeNull();
    // 7 milhões de tokens não podem se apresentar como gasto de zero dólar.
    expect(r.usdTotal).toBe(0); // valor não apurado — o STATUS é que carrega a verdade
  });

  it("a versão do preço existe e é carimbável", () => {
    expect(PRECO_VERSAO).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("unidade: o Cloud Vision cobra por PÁGINA, não por token", () => {
  it("US$ 1,50 por mil páginas", () => {
    const r = precificarUnidades("google-vision:DOCUMENT_TEXT_DETECTION", 1000);
    expect(r.usdTotal).toBeCloseTo(1.5, 6);
    expect(r.desconhecido).toBe(false);
  });

  it("um balancete de 10 páginas custa US$ 0,015", () => {
    expect(precificarUnidades("google-vision:DOCUMENT_TEXT_DETECTION", 10).usdTotal).toBeCloseTo(0.015, 6);
  });

  it("provedor desconhecido também não vira zero silencioso", () => {
    expect(precificarUnidades("provedor-novo:ALGO", 100).desconhecido).toBe(true);
  });
});
