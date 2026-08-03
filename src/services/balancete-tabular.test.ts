/**
 * Leitura de VALOR na via tabular (planilha, CSV e a matriz que o OCR entrega).
 *
 * Flagrado em produção no balancete Budel (03/08/2026): o modelo de visão,
 * embora instruído a devolver número canônico, devolve parte do documento com
 * separador de milhar AMERICANO ("46,706,796.30") — e o leitor, que tratava
 * qualquer vírgula como decimal pt-BR, transformava 46 milhões em 46,70.
 * A DRE saía com Receita Bruta de R$ 50 e o balancete não fechava por 43 milhões.
 */
import { describe, it, expect } from "vitest";
import { parseBalanceteMatriz } from "./balancete-tabular";

const CAB = ["Classificação", "Nome da conta contábil", "Saldo anterior", "Débito", "Crédito", "Saldo atual"];
const ler = (...linhas: string[][]) =>
  parseBalanceteMatriz([["01/07/2015 a 31/07/2015"], CAB, ...linhas] as any).linhas;

describe("valor: formato americano (o que o OCR devolve em parte das páginas)", () => {
  it("milhar por vírgula e decimal por ponto — os quatro valores da linha", () => {
    const [l] = ler(["17", "NAO CIRCULANTE", "46,706,796.30", "869,688.98", "1,934,983.20", "45,641,500.08"]);
    expect(l.saldoAnterior).toBe(46706796.30);
    expect(l.debito).toBe(869688.98);
    expect(l.credito).toBe(1934983.20);
    expect(l.saldoAtual).toBe(45641500.08);
  });

  it("um único grupo de milhar e negativo", () => {
    const [l] = ler(["110599", "(+) DUPLICATAS DESCONTADAS", "-500,520.72", "0.00", "0.00", "7,008.54"]);
    expect(l.saldoAnterior).toBe(-500520.72);
    expect(l.saldoAtual).toBe(7008.54);
  });

  it("sem casas decimais", () => {
    const [l] = ler(["1", "ATIVO", "46,706,796", "0", "0", "46,706,796"]);
    expect(l.saldoAnterior).toBe(46706796);
  });
});

describe("valor: pt-BR continua exatamente como era (sem retrocesso)", () => {
  it("milhar por ponto e decimal por vírgula", () => {
    const [l] = ler(["3101", "RECEITAS", "37.754.258,03", "1.817.921,22", "11.701.541,02", "49.355.886,73"]);
    expect(l.saldoAnterior).toBe(37754258.03);
    expect(l.saldoAtual).toBe(49355886.73);
  });

  it("decimal por vírgula sem milhar, e parênteses como negativo no saldo", () => {
    const [l] = ler(["9", "X", "(1.234,56)", "45,20", "0,00", "-1.189,36"]);
    expect(l.saldoAnterior).toBe(-1234.56);
    expect(l.debito).toBe(45.20); // débito/crédito são magnitudes (contrato de sempre)
    expect(l.saldoAtual).toBe(-1189.36);
  });

  it("ponto decimal puro (en-US sem milhar)", () => {
    const [l] = ler(["9", "X", "1234.56", "0.00", "0.00", "1234.56"]);
    expect(l.saldoAnterior).toBe(1234.56);
  });

  it("ambíguo de um separador só não muda de leitura", () => {
    const [l] = ler(["9", "X", "1.234", "0", "0", "1.234"]);
    expect(l.saldoAnterior).toBe(1.234); // comportamento histórico preservado
  });
});
