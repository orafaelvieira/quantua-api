import { describe, it, expect } from "vitest";
import { calcularModelo } from "./model-engine";
import type { BlocoModelo } from "./model-engine";

/**
 * SAZONALIDADE NOS MODOS SIMPLES (pedido do usuário, 23/07/2026): "% sobre
 * receita" e "valor fixo + índice" passam a aceitar a curva do ano, que já
 * existia nos modos com drivers. O default é UNIFORME (100/12 por mês) — a
 * garantia que estes testes dão é que ligar isso não mexe em modelo nenhum.
 */
const MESES12 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
const UNIFORME = Array(12).fill(1);

function modelo(linhasCusto: Array<Record<string, unknown>>): BlocoModelo[] {
  return [
    { id: "r", tipo: "receitas", nome: "Receitas", ordem: 0, ativo: true, config: {
      linhasReceita: [{ id: "lin1", nome: "Vendas", nodeRaiz: "n1",
        nodes: [{ id: "n1", nome: "Vendas", tipo: "serie", unidade: "R$", params: { modoPreenchimento: "simples", valorMensal: 1000, crescimentoAnual: 0 } }] }],
    } },
    { id: "c", tipo: "custos", nome: "Custos", ordem: 1, ativo: true, config: { linhasCusto } },
  ] as unknown as BlocoModelo[];
}
const custos = (r: { dre: Array<{ grupo?: string; valores: Record<string, number> }> }) => r.dre.filter((l) => l.grupo === "custos");
const totalAno = (r: ReturnType<typeof calcularModelo>) =>
  custos(r).reduce((s, l) => s + MESES12.reduce((x, m) => x + (l.valores[m] ?? 0), 0), 0);
const mes = (r: ReturnType<typeof calcularModelo>, m: string) =>
  custos(r).reduce((s, l) => s + (l.valores[m] ?? 0), 0);

const rodar = (linha: Record<string, unknown>) =>
  calcularModelo({ mesInicial: "2026-01", horizonteMeses: 12, blocks: modelo([linha]) } as never);

describe("sazonalidade nos modos simples", () => {
  it("SEM sazonalidade e com curva UNIFORME dão exatamente o mesmo resultado (fixo)", () => {
    const sem = rodar({ id: "c1", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 1000 });
    const uni = rodar({ id: "c1", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 1000, sazonalidade: UNIFORME });
    expect(totalAno(uni)).toBeCloseTo(totalAno(sem), 6);
    for (const m of MESES12) expect(mes(uni, m)).toBeCloseTo(mes(sem, m), 6);
  });

  it("SEM sazonalidade e com curva UNIFORME dão o mesmo resultado (% da receita)", () => {
    const sem = rodar({ id: "c1", nome: "Comissão", modo: "pctReceita", pct: 0.1 });
    const uni = rodar({ id: "c1", nome: "Comissão", modo: "pctReceita", pct: 0.1, sazonalidade: UNIFORME });
    expect(totalAno(uni)).toBeCloseTo(totalAno(sem), 6);
  });

  it("curva concentrada em dezembro (13º) redistribui SEM mudar o total do ano", () => {
    // 11 meses com peso 0,5 e dezembro com 6,5 → média 1 (soma 12).
    const curva = [...Array(11).fill(0.5), 6.5];
    expect(curva.reduce((a, b) => a + b, 0)).toBeCloseTo(12, 10);
    const sem = rodar({ id: "c1", nome: "Folha", modo: "fixoReajuste", valorMensal: 1000 });
    const com = rodar({ id: "c1", nome: "Folha", modo: "fixoReajuste", valorMensal: 1000, sazonalidade: curva });
    expect(totalAno(com)).toBeCloseTo(totalAno(sem), 6);       // ano preservado
    expect(mes(com, "2026-12")).toBeCloseTo(6500, 6);          // dezembro pesado
    expect(mes(com, "2026-01")).toBeCloseTo(500, 6);           // demais meses leves
  });

  it("modo 'serie' ignora a curva (já é mês a mês, a curva duplicaria o efeito)", () => {
    const valores = Object.fromEntries(MESES12.map((m) => [m, 100]));
    const sem = rodar({ id: "c1", nome: "Manual", modo: "serie", valores });
    const com = rodar({ id: "c1", nome: "Manual", modo: "serie", valores, sazonalidade: [...Array(11).fill(0.5), 6.5] });
    for (const m of MESES12) expect(mes(com, m)).toBeCloseTo(mes(sem, m), 6);
  });
});
