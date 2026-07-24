import { describe, it, expect } from "vitest";
import { ratearAnoComTravas } from "./model-engine";

/**
 * REGRA DO MÊS QUE MANDA (pedido do usuário, 24/07/2026).
 *
 * "no ano a projeção é 100 mas no realizado digitado manualmente pelo analista
 *  de jan a jun foi de 60, os outros 40 precisam ser redistribuídos para fechar
 *  os 100 (60 realizado + 40 projeção); a partir do próximo período respeita
 *  integralmente a sazonalidade."
 *
 * O invariante que estes testes protegem: a soma dos 12 meses SEMPRE fecha no
 * total do ano, com ou sem meses digitados.
 */

const TODOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const UNIFORME = Array(12).fill(1);
const soma = (r: Record<number, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe("ratearAnoComTravas", () => {
  it("EXEMPLO DO USUÁRIO: ano 100, jan–jun digitados somando 60 → jul–dez recebem 40", () => {
    const travados = { 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10 }; // 60
    const r = ratearAnoComTravas(100, TODOS, UNIFORME, travados);
    // Os digitados ficam intactos — são fato.
    for (let m = 1; m <= 6; m++) expect(r[m]).toBe(10);
    // Os 40 restantes vão para os 6 meses livres: 40/6 cada (não 50/6).
    for (let m = 7; m <= 12; m++) expect(r[m]).toBeCloseTo(40 / 6, 10);
    // E o ano fecha em 100 — o invariante.
    expect(soma(r)).toBeCloseTo(100, 10);
  });

  it("ano SEM mês digitado respeita a sazonalidade integralmente (nada muda)", () => {
    const curva = [...Array(11).fill(0.5), 6.5]; // média 1, dezembro pesado
    const r = ratearAnoComTravas(1200, TODOS, curva, {});
    expect(r[12]).toBeCloseTo(1200 * (6.5 / 12), 10);
    expect(r[1]).toBeCloseTo(1200 * (0.5 / 12), 10);
    expect(soma(r)).toBeCloseTo(1200, 10);
  });

  it("os meses livres mantêm ENTRE SI a proporção da sazonalidade", () => {
    const curva = [...Array(11).fill(0.5), 6.5];
    // Trava jan (fato = 100). Sobram 1100 para fev–dez, na proporção da curva.
    const r = ratearAnoComTravas(1200, TODOS, curva, { 1: 100 });
    expect(r[1]).toBe(100);
    const pesosLivres = 0.5 * 10 + 6.5; // fev..nov (10 meses) + dez
    expect(r[12]).toBeCloseTo(1100 * (6.5 / pesosLivres), 10);
    expect(r[2]).toBeCloseTo(1100 * (0.5 / pesosLivres), 10);
    expect(soma(r)).toBeCloseTo(1200, 10);
    // Dezembro continua 13× fevereiro — a curva é preservada entre os livres.
    expect(r[12] / r[2]).toBeCloseTo(13, 10);
  });

  it("digitado ACIMA do total do ano: os livres ficam negativos e o ano fecha (nada é escondido)", () => {
    // Ano 100, mas jan–jun somam 120. O motor não inventa: o resto é −20.
    const r = ratearAnoComTravas(100, TODOS, UNIFORME, { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 20 });
    expect(soma(r)).toBeCloseTo(100, 10);
    expect(r[7]).toBeCloseTo(-20 / 6, 10);
  });

  it("ano INTEIRO digitado: os valores mandam (o total do ano vira a soma deles)", () => {
    const travados = Object.fromEntries(TODOS.map((m) => [m, 5]));
    const r = ratearAnoComTravas(999, TODOS, UNIFORME, travados);
    expect(soma(r)).toBe(60); // 12 × 5 — a premissa anual não sobrepõe fato
  });

  it("ano PARCIAL do horizonte (começa em julho): só os meses presentes entram", () => {
    const julDez = [7, 8, 9, 10, 11, 12];
    const r = ratearAnoComTravas(600, julDez, UNIFORME, {});
    expect(Object.keys(r).length).toBe(6);
    expect(soma(r)).toBeCloseTo(600, 10);
    expect(r[7]).toBeCloseTo(100, 10);
  });

  it("ano parcial COM mês digitado: fecha no total mesmo assim", () => {
    const julDez = [7, 8, 9, 10, 11, 12];
    const r = ratearAnoComTravas(600, julDez, UNIFORME, { 7: 200 });
    expect(r[7]).toBe(200);
    for (let m = 8; m <= 12; m++) expect(r[m]).toBeCloseTo(400 / 5, 10);
    expect(soma(r)).toBeCloseTo(600, 10);
  });

  it("todos os pesos livres ZERO: divide igual em vez de sumir com o resto", () => {
    const curva = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]; // jul–dez com peso 0
    const r = ratearAnoComTravas(120, TODOS, curva, { 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10 });
    // Resto 60 entre 6 meses de peso zero → 10 cada (não zero, senão o ano furaria).
    for (let m = 7; m <= 12; m++) expect(r[m]).toBeCloseTo(10, 10);
    expect(soma(r)).toBeCloseTo(120, 10);
  });
});
