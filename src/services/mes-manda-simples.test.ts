import { describe, it, expect } from "vitest";
import { calcularModelo } from "./model-engine";
import type { BlocoModelo } from "./model-engine";

/**
 * O MÊS DIGITADO MANDA NOS MODOS SIMPLES — ponta a ponta no motor.
 * Cenário real do usuário: o gerencial de jan..N do ano corrente é digitado
 * mês a mês; o resto do ano segue a premissa; o TOTAL DO ANO não muda.
 */
const MESES = (ano: string) => Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, "0")}`);

function modelo(linhasCusto: Array<Record<string, unknown>>): BlocoModelo[] {
  return [
    { id: "r", tipo: "receitas", nome: "Receitas", ordem: 0, ativo: true, config: {
      linhasReceita: [{ id: "lin1", nome: "Vendas", nodeRaiz: "n1",
        nodes: [{ id: "n1", nome: "Vendas", tipo: "serie", unidade: "R$", params: { modoPreenchimento: "simples", valorMensal: 1000, crescimentoAnual: 0 } }] }],
    } },
    { id: "c", tipo: "custos", nome: "Custos", ordem: 1, ativo: true, config: { linhasCusto } },
  ] as unknown as BlocoModelo[];
}
const linhaCusto = (r: ReturnType<typeof calcularModelo>) => r.dre.filter((l) => l.grupo === "custos");
const noMes = (r: ReturnType<typeof calcularModelo>, m: string) => linhaCusto(r).reduce((s, l) => s + (l.valores[m] ?? 0), 0);
const noAno = (r: ReturnType<typeof calcularModelo>, ano: string) => MESES(ano).reduce((s, m) => s + noMes(r, m), 0);
const rodar = (linha: Record<string, unknown>) =>
  calcularModelo({ mesInicial: "2026-01", horizonteMeses: 24, blocks: modelo([linha]) } as never);

describe("mês digitado manda, e o ano fecha (modos simples)", () => {
  it("VALOR FIXO: jan–jun digitados somando 60 mantêm o total do ano da premissa", () => {
    const semTrava = rodar({ id: "c1", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 100 });
    const totalAno = noAno(semTrava, "2026"); // 1200

    const valores: Record<string, number> = {};
    for (let m = 1; m <= 6; m++) valores[`2026-${String(m).padStart(2, "0")}`] = 10; // 60 no semestre
    const comTrava = rodar({ id: "c1", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 100, valores });

    // Os meses digitados valem o que foi digitado.
    for (let m = 1; m <= 6; m++) expect(noMes(comTrava, `2026-${String(m).padStart(2, "0")}`)).toBeCloseTo(10, 6);
    // Os livres absorvem o resto: (1200 − 60) / 6 = 190.
    for (let m = 7; m <= 12; m++) expect(noMes(comTrava, `2026-${String(m).padStart(2, "0")}`)).toBeCloseTo(190, 6);
    // O ANO FECHA no mesmo total — é o invariante.
    expect(noAno(comTrava, "2026")).toBeCloseTo(totalAno, 6);
  });

  it("o ano SEGUINTE volta a respeitar a sazonalidade integralmente", () => {
    const valores = { "2026-01": 10, "2026-02": 10, "2026-03": 10, "2026-04": 10, "2026-05": 10, "2026-06": 10 };
    const r = rodar({ id: "c1", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 100, valores });
    // 2027 não tem mês digitado: todos os meses iguais (curva uniforme).
    const jan27 = noMes(r, "2027-01");
    for (let m = 2; m <= 12; m++) expect(noMes(r, `2027-${String(m).padStart(2, "0")}`)).toBeCloseTo(jan27, 6);
  });

  it("% DA RECEITA: digitar meses não muda o total do ano (o % anual é preservado)", () => {
    const sem = rodar({ id: "c1", nome: "Comissão", modo: "pctReceita", pct: 0.1 });
    const totalAno = noAno(sem, "2026"); // 10% de 12.000 = 1.200
    const com = rodar({ id: "c1", nome: "Comissão", modo: "pctReceita", pct: 0.1, valores: { "2026-01": 300 } });
    expect(noMes(com, "2026-01")).toBeCloseTo(300, 6);
    expect(noAno(com, "2026")).toBeCloseTo(totalAno, 6);
    // Os 11 livres dividem os 900 restantes.
    expect(noMes(com, "2026-02")).toBeCloseTo(900 / 11, 6);
  });

  it("com SAZONALIDADE, os meses livres mantêm a curva entre si", () => {
    const curva = [...Array(11).fill(0.5), 6.5];
    const r = rodar({ id: "c1", nome: "Folha", modo: "fixoReajuste", valorMensal: 100, sazonalidade: curva, valores: { "2026-01": 0 } });
    const pesosLivres = 0.5 * 10 + 6.5;
    const resto = 1200 - 0;
    expect(noMes(r, "2026-12")).toBeCloseTo(resto * (6.5 / pesosLivres), 5);
    expect(noAno(r, "2026")).toBeCloseTo(1200, 5);
  });

  it("SEM meses digitados, o resultado é idêntico ao de antes (nada regride)", () => {
    const a = rodar({ id: "c1", nome: "X", modo: "pctReceita", pct: 0.25 });
    const b = rodar({ id: "c1", nome: "X", modo: "pctReceita", pct: 0.25, valores: {} });
    for (const m of MESES("2026")) expect(noMes(b, m)).toBeCloseTo(noMes(a, m), 10);
  });
});
