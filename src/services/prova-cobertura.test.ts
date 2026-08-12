/**
 * O caso que motivou a prova está no primeiro teste: um grupo cujo TOTAL
 * continua certo enquanto duas contas somem dentro dele. Nenhuma prova de soma
 * pega isso; a de contagem pega.
 */
import { describe, it, expect } from "vitest";
import { provarCobertura, nomesDaArvore, nomeComparavel, motivoDaCobertura, ehLinhaEstrutural, type LinhaDoDocumento } from "./prova-cobertura";

const linha = (conta: string, valor: number) => ({ conta, valores: { "31/12/2025": valor } });

/** ADMINISTRATIVAS como o PDF da Move Farma imprime. */
const DOCUMENTO = [
  linha("Locação de Veículos", -183412.37),
  linha("Locação de Máquinas e Equipamentos", -82171.87),
  linha("Entidades e Associações", -678.86),
  linha("Horas Extras e DSR", -2941.7),
  linha("Energia Elétrica", -101182.39),
  linha("Material de Limpeza", -52239.09),
];

describe("conta que some dentro do grupo", () => {
  it("REPROVA quando a árvore perde contas, mesmo com o total do grupo certo", () => {
    const arvore = [{
      nome: "ADMINISTRATIVAS", valor: -422626.28,
      filhos: [
        { nome: "Locação de Veículos", valor: -183412.37 },
        // as duas seguintes foram absorvidas por este nó, que virou pai:
        { nome: "Locação de Máquinas e Equipamentos", valor: -85792.43, filhos: [] },
        { nome: "Energia Elétrica", valor: -101182.39 },
        { nome: "Material de Limpeza", valor: -52239.09 },
      ],
    }];
    const c = provarCobertura(DOCUMENTO, arvore);
    expect(c.verificavel).toBe(true);
    expect(c.ok).toBe(false);
    expect(c.faltantes.map((f) => f.nome).sort()).toEqual(["Entidades e Associações", "Horas Extras e DSR"]);
    expect(c.encontradas).toBe(4);
    expect(c.totalDocumento).toBe(6);
  });

  it("APROVA quando todas chegaram", () => {
    const arvore = [{ nome: "ADMINISTRATIVAS", filhos: DOCUMENTO.map((l) => ({ nome: l.conta, valor: l.valores["31/12/2025"] })) }];
    expect(provarCobertura(DOCUMENTO, arvore).ok).toBe(true);
  });

  it("o motivo NOMEIA as contas perdidas (nº sozinho não dá o que conferir)", () => {
    const c = provarCobertura(DOCUMENTO, [{ nome: "ADMINISTRATIVAS", filhos: [{ nome: "Locação de Veículos" }] }]);
    const m = motivoDaCobertura(c, "DRE 2025.pdf")!;
    expect(m).toContain("DRE 2025.pdf");
    expect(m).toContain("Energia Elétrica");
  });
});

describe("nome comparável entre leitores", () => {
  it.each([
    ["(-) ICMS", "ICMS"],
    ["(+) Receitas Financeiras", "Receitas Financeiras"],
    ["Impostos, Taxas  e Contribuições", "Impostos, Taxas e Contribuições"],
    ["DESPESA COM PESSOAL", "Despesa com Pessoal"],
    ["Locação de Máquinas", "LOCACAO DE MAQUINAS"],
  ])("%s ≡ %s", (a, b) => expect(nomeComparavel(a)).toBe(nomeComparavel(b)));

  it("não colapsa contas realmente diferentes", () => {
    expect(nomeComparavel("Receitas Financeiras")).not.toBe(nomeComparavel("Despesas Financeiras"));
    expect(nomeComparavel("(-) Vendas Canceladas")).not.toBe(nomeComparavel("(-) Vendas Devolvidas"));
  });

  it("prefixo de sinal não engole o nome inteiro", () => {
    expect(nomeComparavel("(-) De Vendas de Mercadorias")).toBe("de vendas de mercadorias");
  });
});

describe("árvore de BP (períodos → grupos → itens)", () => {
  it("varre grupos e filhos", () => {
    const arv = {
      "31/12/2025": {
        grupos: { "Ativo Circulante": [{ nome: "Caixa", valor: 10, filhos: [{ nome: "Caixa Geral", valor: 10 }] }] },
        totais: { "Ativo Total": 10 },
      },
    };
    const n = nomesDaArvore(arv);
    expect(n.has(nomeComparavel("Ativo Circulante"))).toBe(true);
    expect(n.has(nomeComparavel("Caixa Geral"))).toBe(true);
  });
});

describe("recusa honesta", () => {
  it("parser que leu pouco não é testemunha — não verificável em vez de reprovar", () => {
    const c = provarCobertura([linha("Caixa", 10), linha("Bancos", 20)], [{ nome: "Caixa" }]);
    expect(c.verificavel).toBe(false);
    expect(c.ok).toBe(true);
  });

  it("sem árvore (nível heurístico) não reprova ninguém", () => {
    expect(provarCobertura(DOCUMENTO, null).verificavel).toBe(false);
  });

  it("linha sem valor não é cobrada (cabeçalho, rodapé, linha em branco)", () => {
    const doc = [...DOCUMENTO, { conta: "TOTAL GERAL", valores: { "31/12/2025": 0 } }];
    const arvore = [{ nome: "ADMINISTRATIVAS", filhos: DOCUMENTO.map((l) => ({ nome: l.conta })) }];
    expect(provarCobertura(doc, arvore).ok).toBe(true);
  });

  it("a mesma conta em vários períodos conta uma vez só", () => {
    const doc: LinhaDoDocumento[] = [
      { conta: "Caixa", valores: { "31/12/2024": 10, "31/12/2025": 20 } },
      { conta: "Bancos", valores: { "31/12/2024": 30, "31/12/2025": 40 } },
      { conta: "Clientes", valores: { "31/12/2025": 50 } },
      { conta: "Estoques", valores: { "31/12/2025": 60 } },
      { conta: "Fornecedores", valores: { "31/12/2025": 70 } },
    ];
    const arv = [{ nome: "Caixa" }, { nome: "Bancos" }, { nome: "Clientes" }, { nome: "Estoques" }, { nome: "Fornecedores" }];
    const c = provarCobertura(doc, arv);
    expect(c.totalDocumento).toBe(5);
    expect(c.ok).toBe(true);
  });
});

describe("nome quebrado em duas linhas", () => {
  const doc = [
    linha("DEPRECIAÇÃO/AMORTIZAÇÃO/EXAUSTÃO", -218593.23),
    linha("BENS EM OPERAÇÃO", 784001.54),
    linha("IMOBILIZADO EM ANDAMENTO", 117220.62),
    linha("INTANGÍVEL", 1696),
    linha("CUSTO", 1696),
    linha("CLIENTES", 5000),
  ];
  it("o pedaço lido pelo parser casa com o nome inteiro da árvore", () => {
    const arv = [
      { nome: "(-) DEPRECIAÇÃO/AMORTIZAÇÃO/EXAUSTÃO ACUMULADA", valor: -218593.23 },
      { nome: "BENS EM OPERAÇÃO" }, { nome: "IMOBILIZADO EM ANDAMENTO" },
      { nome: "INTANGÍVEL" }, { nome: "CUSTO" }, { nome: "CLIENTES" },
    ];
    expect(provarCobertura(doc, arv).ok).toBe(true);
  });

  it("nome CURTO não casa por prefixo — seriam contas diferentes", () => {
    const arv = [
      { nome: "(-) DEPRECIAÇÃO/AMORTIZAÇÃO/EXAUSTÃO ACUMULADA" },
      { nome: "BENS EM OPERAÇÃO" }, { nome: "IMOBILIZADO EM ANDAMENTO" },
      { nome: "INTANGÍVEL" }, { nome: "CUSTO DE MERCADORIAS VENDIDAS" }, { nome: "CLIENTES" },
    ];
    const c = provarCobertura(doc, arv);
    expect(c.ok).toBe(false);
    expect(c.faltantes.map((f) => f.nome)).toEqual(["CUSTO"]);
  });
});

/**
 * FECHAMENTO DO BALANÇO em todas as grafias do acervo. O caso Dunamys
 * (12/08/2026): "PASSIVO + PATRIMÔNIO LÍQUIDO" era cobrado como conta e
 * derrubava três balanços corretos.
 */
describe("linha de fechamento do balanço não é conta", () => {
  it.each([
    "PASSIVO + PATRIMÔNIO LÍQUIDO",
    "PASSIVO E PATRIMONIO LIQUIDO",
    "ATIVO + PATRIMÔNIO LÍQUIDO",
    "TOTAL DO PASSIVO E PATRIMÔNIO LÍQUIDO",
    "PASSIVO TOTAL",
    "ATIVO",
    "PATRIMÔNIO LÍQUIDO",
  ])("%s", (nome) => expect(ehLinhaEstrutural(nome)).toBe(true));

  it.each([
    "Passivos Contingentes",
    "Bradesco Invest Fácil 23456-7",
    "Ativos Biológicos",
  ])("mas %s continua sendo conta", (nome) => expect(ehLinhaEstrutural(nome)).toBe(false));
});
