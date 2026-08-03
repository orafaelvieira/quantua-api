/**
 * Via de OCR do balancete — as partes DETERMINÍSTICAS (a leitura por visão em
 * si não é testável offline). Trava o contrato: formato canônico de número,
 * coluna "Reduzida" com casa própria, auditoria pela equação e conserto pela
 * árvore. Fixtures sintéticas — documento de cliente não vai para o repo (LGPD).
 */
import { describe, it, expect } from "vitest";
import { linhaFecha } from "./balancete-ocr";
import { parseBalanceteMatriz } from "./balancete-tabular";
import { converterBalancete } from "./balancete-conversao";

const CAB = ["Classificação", "Nome da conta contábil", "Saldo anterior", "Débito", "Crédito", "Saldo atual"];
const matriz = (linhas: string[][]) => [["Período: 01/07/2015 a 31/07/2015"], CAB, ...linhas];

describe("linhaFecha — a equação do documento é o juiz do OCR", () => {
  it("devedora coerente fecha", () => {
    expect(linhaFecha({ saldoAnterior: 900, debito: 700, credito: 100, saldoAtual: 1500 })).toBe(true);
  });
  it("credora coerente fecha (sem natureza declarada)", () => {
    expect(linhaFecha({ saldoAnterior: 500, debito: 50, credito: 450, saldoAtual: 900 })).toBe(true);
  });
  it("um dígito errado NÃO fecha — é assim que o erro de OCR aparece", () => {
    // Caso real do documento escaneado (conta CAIXA): 7.816,10 + 4.146.103,86
    // − 4.131.915,01 = 22.004,95. Duas leituras do mesmo papel discordaram
    // justamente no dígito do saldo anterior (7.816,10 × 7.815,10) e o total
    // do grupo saiu 2.204,95 — cada uma dessas trocas quebra a equação, que é
    // exatamente o sinal que a auditoria persegue.
    expect(linhaFecha({ saldoAnterior: 7816.1, debito: 4146103.86, credito: 4131915.01, saldoAtual: 22004.95 })).toBe(true);
    expect(linhaFecha({ saldoAnterior: 7816.1, debito: 4146103.86, credito: 4131915.01, saldoAtual: 2204.95 })).toBe(false);
    expect(linhaFecha({ saldoAnterior: 7815.1, debito: 4146103.86, credito: 4131915.01, saldoAtual: 22004.95 })).toBe(false);
  });
  it("natureza declarada nos dois retratos usa a equação ASSINADA (conta que vira de natureza)", () => {
    expect(linhaFecha({
      saldoAnterior: 2485223.6, naturezaAnterior: "C", debito: 58450567.81, credito: 54300432.64,
      saldoAtual: 1664911.57, naturezaAtual: "D",
    })).toBe(true);
  });
});

describe("número canônico do OCR (sem separador de milhar, ponto decimal)", () => {
  it("é lido sem ambiguidade de locale — o modelo normaliza para en-US e brigar com isso quebra", () => {
    const p = parseBalanceteMatriz(matriz([
      ["1", "ATIVO", "62085267.76", "40481421.93", "40622692.20", "61943997.49"],
    ]));
    expect(p.linhas[0].saldoAnterior).toBe(62085267.76);
    expect(p.linhas[0].saldoAtual).toBe(61943997.49);
  });
  it("negativo com sinal e valor com centavos convivem", () => {
    const p = parseBalanceteMatriz(matriz([["1101", "CAIXA", "-45.20", "0.00", "0.00", "-45.20"]]));
    expect(p.linhas[0].saldoAnterior).toBe(-45.2);
  });
});

describe("documento escaneado que FECHA vira extração confiável", () => {
  // Mesma história dos testes das outras vias: se o OCR ler certo, as provas
  // passam exatamente como no PDF de texto e na planilha.
  const bom = [
    ["1", "ATIVO", "0.00", "1000000.00", "0.00", "1000000.00"],
    ["11", "CIRCULANTE", "0.00", "1000000.00", "0.00", "1000000.00"],
    ["1101", "CAIXA", "0.00", "1000000.00", "0.00", "1000000.00"],
    ["2", "PASSIVO", "0.00", "0.00", "700000.00", "700000.00"],
    ["21", "CAPITAL SOCIAL", "0.00", "0.00", "700000.00", "700000.00"],
    ["3", "RECEITAS", "0.00", "0.00", "500000.00", "500000.00"],
    ["31", "VENDAS", "0.00", "0.00", "500000.00", "500000.00"],
    ["4", "DESPESAS", "0.00", "200000.00", "0.00", "200000.00"],
    ["41", "ALUGUEL", "0.00", "200000.00", "0.00", "200000.00"],
  ];
  it("P2 e P3 passam com a leitura correta", () => {
    const c = converterBalancete(parseBalanceteMatriz(matriz(bom)));
    expect(c.provas.fechamento.ok).toBe(true);
    expect(c.provas.linhas.ok).toBe(true);
    expect(c.periodoBP).toBe("31/07/2015");
  });
  it("UM dígito trocado derruba a prova — o selo não fica verde por engano", () => {
    const ruim = bom.map((l) => (l[0] === "1101" ? [...l.slice(0, 5), "100000.00"] : l));
    const c = converterBalancete(parseBalanceteMatriz(matriz(ruim)));
    expect(c.provas.linhas.ok).toBe(false);
    expect(c.provas.linhas.incoerentes[0].nome).toBe("CAIXA");
  });
});
