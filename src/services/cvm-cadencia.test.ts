import { describe, it, expect } from "vitest";
import { pausaAdaptativa, ALVO_ATRASO_LOOP_MS, TETO_PAUSA_MS } from "./cvm-sync";

/**
 * CADÊNCIA DO RECÁLCULO DA CVM (revista em 24/07/2026).
 *
 * Contexto que estes testes preservam: a pausa fixa de 75ms por empresa existia
 * para sobreviver ao health check de 1s do DigitalOcean. No Cloud Run não há
 * liveness probe, e a medição mostrou que 98% do tempo do recálculo era espera
 * fabricada (78,5s de pausa para 1,3s de CPU por arquivo).
 *
 * A pausa passou a reagir ao atraso REAL do event loop. O que não pode se
 * perder: com o loop folgado o recálculo não paga pedágio; com o loop
 * congestionado ele devolve tempo — e nunca congela.
 */
describe("pausaAdaptativa", () => {
  it("loop FOLGADO não paga pausa (o caso normal — é daqui que vem a aceleração)", () => {
    expect(pausaAdaptativa(0)).toBe(0);
    expect(pausaAdaptativa(1)).toBe(0);
    expect(pausaAdaptativa(26)).toBe(0); // o atraso medido hoje em produção
  });

  it("exatamente NO alvo ainda não paga (o alvo é o limite tolerado)", () => {
    expect(pausaAdaptativa(ALVO_ATRASO_LOOP_MS)).toBe(0);
  });

  it("acima do alvo devolve ao loop o tempo que ele atrasou", () => {
    expect(pausaAdaptativa(80)).toBe(80);
    expect(pausaAdaptativa(120.4)).toBe(120);
  });

  it("TETO: um pico isolado não congela o recálculo", () => {
    expect(pausaAdaptativa(10_000)).toBe(TETO_PAUSA_MS);
    expect(pausaAdaptativa(Number.MAX_SAFE_INTEGER)).toBe(TETO_PAUSA_MS);
  });

  it("medida INVÁLIDA não pausa — é sinal de instrumentação quebrada, não de carga", () => {
    // NaN/Infinity só apareceriam se o monitor do event loop falhasse. Pausar
    // meio segundo a cada respiro por causa de uma leitura ruim seria trocar um
    // problema de medição por lentidão real; e setTimeout(NaN) dispara na hora.
    expect(pausaAdaptativa(NaN)).toBe(0);
    expect(pausaAdaptativa(Infinity)).toBe(0);
    expect(pausaAdaptativa(-5)).toBe(0);
  });

  it("é MONOTÔNICA no domínio válido: mais atraso nunca resulta em menos pausa", () => {
    let anterior = -1;
    for (const ms of [0, 10, 50, 51, 100, 300, 500, 900, 5000]) {
      const p = pausaAdaptativa(ms);
      expect(p).toBeGreaterThanOrEqual(anterior);
      anterior = p;
    }
  });

  it("o alvo é folgado o bastante para o recálculo não se auto-pausar", () => {
    // Uma empresa custa ~2ms de CPU; entre dois respiros (25 empresas) o loop
    // acumula ~50ms de trabalho. O alvo precisa acomodar isso sem penalizar,
    // senão a pausa dispararia por causa do PRÓPRIO recálculo, não da carga.
    expect(ALVO_ATRASO_LOOP_MS).toBeGreaterThanOrEqual(50);
  });

  it("orçamento de pausa por arquivo cai de ~78s para poucos segundos", () => {
    const EMPRESAS = 683;
    const antes = (75 + 1000 / 25) * EMPRESAS; // 75ms/empresa + 1s a cada 25
    // Depois: setImmediate (custo ~0) e pausa só quando o loop atrasa. No perfil
    // observado em produção (26ms) nenhum respiro cobra pedágio.
    const respiros = Math.floor(EMPRESAS / 25);
    const depois = respiros * pausaAdaptativa(26);
    expect(antes).toBeGreaterThan(70_000);
    expect(depois).toBe(0);
  });

  it("sob congestionamento REAL a proteção volta a agir", () => {
    // Loop atrasando 300ms: cada respiro devolve 300ms ao servidor.
    const respiros = Math.floor(683 / 25);
    expect(respiros * pausaAdaptativa(300)).toBe(respiros * 300);
  });
});
