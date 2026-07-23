import { describe, it, expect } from "vitest";
import { calcularModelo } from "./model-engine";
import type { BlocoModelo } from "./model-engine";

/**
 * DESTINO DE LINHA E DUPLICAÇÃO (pergunta do usuário, 23/07/2026).
 *
 * A tela vai passar a mostrar a conta canônica JÁ SELECIONADA quando a linha se
 * chama como ela ("Custo Operacional" → destino "Custo Operacional"). A dúvida
 * legítima: apontar a linha para a conta que ela já é DUPLICA o valor?
 *
 * Estes testes provam que não, direto no motor: o total do grupo é o MESMO com
 * e sem destino, inclusive no caso de auto-referência. A razão está em
 * `aplicarDestinos`: linha COM destino não vira linha própria (é consumida) —
 * ela só soma no alvo.
 */

const MESES = ["2026-01", "2026-02"];

function modeloCom(linhasCusto: Array<Record<string, unknown>>): BlocoModelo[] {
  return [
    {
      id: "b-rec", tipo: "receitas", nome: "Receitas", ordem: 0, ativo: true,
      config: {
        linhasReceita: [{
          id: "lin1", nome: "Vendas", nodeRaiz: "n1",
          nodes: [{ id: "n1", nome: "Vendas", tipo: "serie", unidade: "R$", params: { modoPreenchimento: "simples", valorMensal: 1000, crescimentoAnual: 0 } }],
        }],
      },
    },
    { id: "b-cus", tipo: "custos", nome: "Custos", ordem: 1, ativo: true, config: { linhasCusto } },
  ] as unknown as BlocoModelo[];
}

/** Linhas de CUSTO da DRE calculada (o resultado não expõe `custos` solto). */
const custosDe = (r: { dre: Array<{ id: string; nome: string; grupo?: string; valores: Record<string, number> }> }) =>
  r.dre.filter((l) => l.grupo === "custos");
const somaGrupo = (linhas: Array<{ valores: Record<string, number> }>) =>
  linhas.reduce((s, l) => s + MESES.reduce((x, m) => x + (l.valores[m] ?? 0), 0), 0);

describe("destino de linha não duplica valor", () => {
  it("AUTO-REFERÊNCIA: linha 'Custo Operacional' apontando para 'Custo Operacional' dá o MESMO total", () => {
    const semDestino = calcularModelo({
      mesInicial: "2026-01", horizonteMeses: 2,
      blocks: modeloCom([{ id: "c1", nome: "Custo Operacional", modo: "pctReceita", pct: 0.3 }]),
    });
    const comDestino = calcularModelo({
      mesInicial: "2026-01", horizonteMeses: 2,
      blocks: modeloCom([{ id: "c1", nome: "Custo Operacional", modo: "pctReceita", pct: 0.3, destino: { conta: "Custo Operacional", sinal: "soma" } }]),
    });
    const totalSem = somaGrupo(custosDe(semDestino));
    const totalCom = somaGrupo(custosDe(comDestino));
    expect(totalCom).toBeCloseTo(totalSem, 6);
    // E continua UMA linha só — não vira duas com o mesmo nome.
    expect(custosDe(comDestino).length).toBe(1);
    expect(custosDe(comDestino)[0].nome).toBe("Custo Operacional");
  });

  it("linha COM destino não vira linha própria (é consumida pelo alvo)", () => {
    const r = calcularModelo({
      mesInicial: "2026-01", horizonteMeses: 2,
      blocks: modeloCom([
        { id: "c1", nome: "Custo Operacional", modo: "pctReceita", pct: 0.3 },
        { id: "c2", nome: "Fretes sobre compras", modo: "pctReceita", pct: 0.1, destino: { conta: "Custo Operacional", sinal: "soma" } },
      ]),
    });
    // Uma linha só na saída: 30% + 10% = 40% da receita.
    expect(custosDe(r).length).toBe(1);
    expect(custosDe(r)[0].nome).toBe("Custo Operacional");
    expect(somaGrupo(custosDe(r))).toBeCloseTo(2000 * 0.4, 6);
    // "Fretes" NÃO aparece em separado — se aparecesse, o valor estaria dobrado.
    expect(custosDe(r).some((l) => /frete/i.test(l.nome))).toBe(false);
  });

  it("total do grupo é invariante: mesmas linhas, com e sem destino", () => {
    const linhas = [
      { id: "c1", nome: "Custo Operacional", modo: "pctReceita", pct: 0.25 },
      { id: "c2", nome: "Custos com Pessoas (MOD)", modo: "pctReceita", pct: 0.15 },
    ];
    const solto = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 2, blocks: modeloCom(linhas) });
    const juntos = calcularModelo({
      mesInicial: "2026-01", horizonteMeses: 2,
      blocks: modeloCom([linhas[0], { ...linhas[1], destino: { conta: "Custo Operacional", sinal: "soma" } }]),
    });
    expect(somaGrupo(custosDe(juntos))).toBeCloseTo(somaGrupo(custosDe(solto)), 6);
    expect(custosDe(solto).length).toBe(2);  // duas linhas na DRE
    expect(custosDe(juntos).length).toBe(1); // uma linha só — mesmo total
  });

  it("sinal REDUZ subtrai do alvo (crédito/devolução), sem criar linha própria", () => {
    const r = calcularModelo({
      mesInicial: "2026-01", horizonteMeses: 2,
      blocks: modeloCom([
        { id: "c1", nome: "Custo Operacional", modo: "pctReceita", pct: 0.30 },
        { id: "c2", nome: "Créditos de PIS/COFINS", modo: "pctReceita", pct: 0.05, destino: { conta: "Custo Operacional", sinal: "reduz" } },
      ]),
    });
    expect(custosDe(r).length).toBe(1);
    expect(somaGrupo(custosDe(r))).toBeCloseTo(2000 * 0.25, 6);
  });
});
