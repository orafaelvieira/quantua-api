import { describe, it, expect } from "vitest";
import { proximoCodigo, codificarLinhas, tipoDaLinha, blocoDoTipo, ehTipoConta, tipoDoTextoDaPlanilha } from "./classificacao-conta";

/**
 * O código é IDENTIFICADOR (o PROCV do analista depende dele): nunca repete,
 * nunca reaproveita número apagado e nasce na família do tipo da conta.
 */

describe("proximoCodigo", () => {
  it("começa em 001 na família do tipo", () => {
    expect(proximoCodigo("custo", [])).toBe("4.1.001");
    expect(proximoCodigo("despesa", [])).toBe("4.2.001");
    expect(proximoCodigo("despesaFinanceira", [])).toBe("4.3.001");
    expect(proximoCodigo("capex", [])).toBe("1.2.001");
    expect(proximoCodigo("receitaOperacional", [])).toBe("3.1.001");
    expect(proximoCodigo("receitaFinanceira", [])).toBe("3.2.001");
    expect(proximoCodigo("outrasReceitas", [])).toBe("3.9.001");
  });

  it("retoma da MAIOR da família — apagar a 002 não faz a próxima colidir com Excel antigo", () => {
    expect(proximoCodigo("despesa", ["4.2.001", "4.2.003"])).toBe("4.2.004");
  });

  it("não invade família alheia nem repete código de outra família", () => {
    expect(proximoCodigo("custo", ["4.2.001", "4.2.002"])).toBe("4.1.001");
    // Código do cliente ocupando a vaga: pula para a próxima livre.
    expect(proximoCodigo("custo", ["4.1.001"])).toBe("4.1.002");
  });
});

describe("codificarLinhas", () => {
  it("preenche só os vazios e preserva o código que o cliente já trouxe", () => {
    const m = codificarLinhas([
      { id: "a", codigo: "3.01.0001", tipo: "custo" },   // plano do cliente: intocado
      { id: "b", codigo: "", tipo: "custo" },
      { id: "c", codigo: null, tipo: "despesa" },
    ]);
    expect(m).toEqual([
      { id: "b", codigo: "4.1.001", motivo: "vazio" },
      { id: "c", codigo: "4.2.001", motivo: "vazio" },
    ]);
  });

  it("DUPLICADO é resolvido — o segundo ganha código novo (PROCV não pode ter dois)", () => {
    const m = codificarLinhas([
      { id: "a", codigo: "4.2.001", tipo: "despesa" },
      { id: "b", codigo: "4.2.001", tipo: "despesa" },
    ]);
    expect(m).toEqual([{ id: "b", codigo: "4.2.002", motivo: "duplicado" }]);
  });

  it("nada a fazer quando todos têm código único", () => {
    expect(codificarLinhas([
      { id: "a", codigo: "4.1.001", tipo: "custo" },
      { id: "b", codigo: "4.2.001", tipo: "despesa" },
    ])).toEqual([]);
  });

  it("dois vazios seguidos não recebem o MESMO código", () => {
    const m = codificarLinhas([
      { id: "a", codigo: "", tipo: "despesa" },
      { id: "b", codigo: "", tipo: "despesa" },
    ]);
    expect(m.map((x) => x.codigo)).toEqual(["4.2.001", "4.2.002"]);
    expect(new Set(m.map((x) => x.codigo)).size).toBe(2);
  });
});

describe("tipo ↔ bloco", () => {
  it("o bloco do motor decide onde o valor entra na DRE", () => {
    expect(blocoDoTipo("custo")).toBe("custos");
    expect(blocoDoTipo("despesaFinanceira")).toBe("despesasNaoOp");
    expect(blocoDoTipo("capex")).toBe("capex");
    expect(blocoDoTipo("outrasReceitas")).toBe("receitasNaoOp");
  });

  it("lê o tipo da linha pelo bloco em que ela está", () => {
    expect(tipoDaLinha("custos", { nome: "Matéria-prima" })).toBe("custo");
    expect(tipoDaLinha("capex", { nome: "Máquina" })).toBe("capex");
    expect(tipoDaLinha("receitas", { nome: "Vendas" })).toBe("receitaOperacional");
  });

  it("receitasNaoOp desempata por código, depois pelo nome", () => {
    expect(tipoDaLinha("receitasNaoOp", { codigo: "3.2.001", nome: "Qualquer" })).toBe("receitaFinanceira");
    expect(tipoDaLinha("receitasNaoOp", { nome: "Rendimento de aplicação" })).toBe("receitaFinanceira");
    expect(tipoDaLinha("receitasNaoOp", { nome: "Venda de maquinário usado" })).toBe("outrasReceitas");
  });

  it("ehTipoConta barra valor inventado (a rota não aceita tipo fora da lista)", () => {
    expect(ehTipoConta("despesa")).toBe(true);
    expect(ehTipoConta("imposto")).toBe(false);
    expect(ehTipoConta(null)).toBe(false);
  });
});

/**
 * O TEXTO DO TIPO SÓ CLASSIFICA COMO FISCAL POR DECLARAÇÃO EXATA (05/08/2026).
 *
 * Esta coluna não recebe só o dropdown do modelo: NOMES_TIPO também casa os
 * cabeçalhos "Natureza"/"Grupo"/"Classificação gerencial" da planilha DO
 * CLIENTE. A primeira versão usava regex solto (/imposto|tributo|.../) e um
 * grupo gerencial "Impostos e Taxas" — IPTU, IPVA, alvará, despesa operacional
 * comum — reclassificaria o grupo inteiro para fora do EBITDA ao reimportar
 * uma planilha antiga, sem aviso. Classe fiscal move dinheiro de lugar: só
 * entra por declaração inequívoca.
 */
describe("tipoDoTextoDaPlanilha — classes fiscais só por rótulo exato", () => {
  it("os rótulos do dropdown classificam", () => {
    expect(tipoDoTextoDaPlanilha("Imposto sobre faturamento", false)).toBe("impostoReceita");
    expect(tipoDoTextoDaPlanilha("Impostos s/ Faturamento", false)).toBe("impostoReceita");
    expect(tipoDoTextoDaPlanilha("IRPJ/CSLL", false)).toBe("impostoResultado");
    expect(tipoDoTextoDaPlanilha("Dedução da receita", false)).toBe("deducaoReceita");
  });

  it("texto GENÉRICO de plano gerencial do cliente NÃO reclassifica (regressão)", () => {
    // Cada um destes caía nos regex soltos da 1ª versão e mudaria a DRE de uma
    // importação antiga refeita:
    expect(tipoDoTextoDaPlanilha("Impostos e Taxas", true)).toBe("custo");           // IPTU/IPVA/alvará
    expect(tipoDoTextoDaPlanilha("Impostos e Taxas", false)).toBe("despesa");
    expect(tipoDoTextoDaPlanilha("Contribuição Social s/ Folha", false)).toBe("despesa"); // INSS patronal
    expect(tipoDoTextoDaPlanilha("Deduções de Vendas", false)).toBe("despesa");
    expect(tipoDoTextoDaPlanilha("ICMS", false)).toBe("despesa");                    // nome de tributo NÃO é declaração de tipo
  });

  it("os rótulos antigos continuam valendo (planilha baixada antes de hoje)", () => {
    expect(tipoDoTextoDaPlanilha("Custo", false)).toBe("custo");
    expect(tipoDoTextoDaPlanilha("Despesa", true)).toBe("despesa");
    expect(tipoDoTextoDaPlanilha("Despesa financeira", false)).toBe("despesaFinanceira");
    expect(tipoDoTextoDaPlanilha("Capex (investimento)", false)).toBe("capex");
  });
});
