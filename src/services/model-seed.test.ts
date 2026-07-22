import { describe, it, expect } from "vitest";
import { derivarAberturaReceita, derivarAberturaCustos, derivarAberturaCustosCanonica, regraDaConta, cagrDaSerie, ultimoCrescimentoPositivo, normConta, TETO_CRESCIMENTO_CONTA } from "./model-seed";

const PERIODOS = ["31/12/2023", "31/12/2024"];

/** DRE canônica mínima: Receita Bruta positiva + Receita Líquida (subtotal). */
function dreCanonica(bruta: Record<string, number>) {
  return [
    { conta: "Receita Bruta", valores: bruta },
    { conta: "Deduções da Receita Bruta", valores: { "31/12/2023": -50, "31/12/2024": -60 } },
    { conta: "Receita Líquida", valores: { "31/12/2023": 950, "31/12/2024": 1140 } },
    { conta: "Custo Operacional", valores: {} },
  ];
}

describe("derivarAberturaReceita", () => {
  it("árvore original: usa os NOMES EXATOS do documento (filhos do agregado)", () => {
    const dados = {
      periodos: PERIODOS,
      dre: dreCanonica({ "31/12/2023": 1000, "31/12/2024": 1200 }),
      arvoreOriginalDRE: {
        "31/12/2023": [
          {
            nome: "RECEITA OPERACIONAL BRUTA", valor: 1000, destino: "Receita Bruta",
            filhos: [
              { nome: "Vendas no Mercado Local", valor: 700, destino: "(absorvido em Receita Bruta)" },
              { nome: "Vendas no Mercado Externo", valor: 300, destino: "(absorvido em Receita Bruta)" },
            ],
          },
        ],
        "31/12/2024": [
          {
            nome: "RECEITA OPERACIONAL BRUTA", valor: 1200, destino: "Receita Bruta",
            filhos: [
              { nome: "Vendas no Mercado Local", valor: 800, destino: "(absorvido em Receita Bruta)" },
              { nome: "Vendas no Mercado Externo", valor: 400, destino: "(absorvido em Receita Bruta)" },
            ],
          },
        ],
      },
    };
    const abertura = derivarAberturaReceita(dados);
    expect(abertura.map((a) => a.conta)).toEqual(["Vendas no Mercado Local", "Vendas no Mercado Externo"]);
    expect(abertura[0].valores).toEqual({ "31/12/2023": 700, "31/12/2024": 800 });
    expect(abertura[1].valores).toEqual({ "31/12/2023": 300, "31/12/2024": 400 });
  });

  it("árvore flat (sem filhos): cada item de receita vira uma linha com o nome do documento", () => {
    const dados = {
      periodos: PERIODOS,
      dre: dreCanonica({ "31/12/2023": 1000, "31/12/2024": 1200 }),
      arvoreOriginalDRE: {
        "31/12/2023": [{ nome: "Receita de Serviços Prestados", valor: 1000, destino: "Receita Bruta" }],
        "31/12/2024": [{ nome: "Receita de Serviços Prestados", valor: 1200, destino: "Receita Bruta" }],
      },
    };
    const abertura = derivarAberturaReceita(dados);
    expect(abertura).toEqual([
      { conta: "Receita de Serviços Prestados", valores: { "31/12/2023": 1000, "31/12/2024": 1200 } },
    ]);
  });

  it("fonte extinta (zero no último período) não vira linha de projeção", () => {
    const dados = {
      periodos: PERIODOS,
      dre: dreCanonica({ "31/12/2023": 1000, "31/12/2024": 1200 }),
      arvoreOriginalDRE: {
        "31/12/2023": [
          { nome: "Vendas de Produtos", valor: 600, destino: "Receita Bruta" },
          { nome: "Receita de Aluguéis", valor: 400, destino: "Receita Bruta" },
        ],
        "31/12/2024": [{ nome: "Vendas de Produtos", valor: 1200, destino: "Receita Bruta" }],
      },
    };
    const abertura = derivarAberturaReceita(dados);
    expect(abertura.map((a) => a.conta)).toEqual(["Vendas de Produtos"]);
  });

  it("sem árvore (captura legada): cai na heurística da DRE canônica", () => {
    const dados = {
      periodos: PERIODOS,
      dre: dreCanonica({ "31/12/2023": 1000, "31/12/2024": 1200 }),
    };
    const abertura = derivarAberturaReceita(dados);
    expect(abertura).toEqual([
      { conta: "Receita Bruta", valores: { "31/12/2023": 1000, "31/12/2024": 1200 } },
    ]);
  });
});

describe("derivarAberturaCustos", () => {
  const dreComCustos = [
    { conta: "Receita Bruta", valores: { "31/12/2023": 1000, "31/12/2024": 1200 } },
    { conta: "Receita Líquida", valores: { "31/12/2023": 950, "31/12/2024": 1140 }, subtotal: true },
    { conta: "Custo Operacional", valores: { "31/12/2023": -400, "31/12/2024": -500 } },
    { conta: "Lucro Bruto", valores: { "31/12/2023": 550, "31/12/2024": 640 }, subtotal: true },
    { conta: "Despesas Gerais e Administrativas", valores: { "31/12/2023": -100, "31/12/2024": -120 } },
    { conta: "EBITDA", valores: { "31/12/2023": 450, "31/12/2024": 520 }, subtotal: true },
  ];

  it("árvore original: nomes exatos do documento, valores em ABS", () => {
    const dados = {
      periodos: ["31/12/2023", "31/12/2024"],
      dre: dreComCustos,
      arvoreOriginalDRE: {
        "31/12/2023": [
          { nome: "Aluguel e Condomínio", valor: -60, destino: "Despesas Gerais e Administrativas" },
          { nome: "Energia Elétrica", valor: -40, destino: "Despesas Gerais e Administrativas" },
          { nome: "CMV", valor: -400, destino: "Custo Operacional" },
        ],
        "31/12/2024": [
          { nome: "Aluguel e Condomínio", valor: -70, destino: "Despesas Gerais e Administrativas" },
          { nome: "Energia Elétrica", valor: -50, destino: "Despesas Gerais e Administrativas" },
          { nome: "CMV", valor: -500, destino: "Custo Operacional" },
        ],
      },
    };
    const abertura = derivarAberturaCustos(dados);
    expect(abertura.map((a) => a.conta)).toEqual(["Aluguel e Condomínio", "Energia Elétrica", "CMV"]);
    expect(abertura[0].valores).toEqual({ "31/12/2023": 60, "31/12/2024": 70 });
    expect(abertura[2].valores).toEqual({ "31/12/2023": 400, "31/12/2024": 500 });
    // DESTINO canônico acompanha cada linha — é ele que separa o bloco Custos ×
    // Despesas no seed do modelo (F1 do histórico nas projeções).
    expect(abertura.map((a) => a.destino)).toEqual([
      "Despesas Gerais e Administrativas", "Despesas Gerais e Administrativas", "Custo Operacional",
    ]);
  });

  it("filhos absorvidos herdam o destino do pai (agregado do documento)", () => {
    const dados = {
      periodos: ["31/12/2023"],
      dre: [
        { conta: "Receita Bruta", valores: { "31/12/2023": 1000 } },
        { conta: "Receita Líquida", valores: { "31/12/2023": 950 }, subtotal: true },
        { conta: "Despesas Gerais e Administrativas", valores: { "31/12/2023": -100 } },
        { conta: "EBITDA", valores: { "31/12/2023": 850 }, subtotal: true },
      ],
      arvoreOriginalDRE: {
        "31/12/2023": [
          {
            nome: "Despesas Administrativas", valor: -100, destino: "Despesas Gerais e Administrativas",
            filhos: [
              { nome: "Despesas c/ Pessoal", valor: -60 },
              { nome: "Despesas c/ Administração", valor: -40 },
            ],
          },
        ],
      },
    };
    const abertura = derivarAberturaCustos(dados);
    expect(abertura.map((a) => a.conta)).toEqual(["Despesas c/ Pessoal", "Despesas c/ Administração"]);
    expect(abertura.every((a) => a.destino === "Despesas Gerais e Administrativas")).toBe(true);
  });

  it("sem árvore: cai nas contas canônicas (ABS), sem subtotais", () => {
    const abertura = derivarAberturaCustos({ periodos: ["31/12/2023", "31/12/2024"], dre: dreComCustos });
    expect(abertura.map((a) => a.conta)).toEqual(["Custo Operacional", "Despesas Gerais e Administrativas"]);
    expect(abertura[0].valores["31/12/2024"]).toBe(500);
    expect(abertura[0].destino).toBe("Custo Operacional");
  });

  // Caso real Move Farma 2023: a captura de IA aninhou contas IRMÃS do grupo de
  // custos como "filhas" do CMV (o CMV não é subtotal delas — a soma não fecha
  // com ele). Descer só um nível deixava as netas de fora: 7 contas zeradas no
  // histórico e a abertura não fechava com o total do bloco.
  it("netas mal aninhadas (irmãs sob a 1ª conta) entram na abertura e fecham com o grupo", () => {
    const dados = {
      periodos: ["31/12/2023"],
      dre: [
        { conta: "Receita Bruta", valores: { "31/12/2023": 842167.29 } },
        { conta: "Receita Líquida", valores: { "31/12/2023": 775890.98 }, subtotal: true },
        { conta: "Custo Operacional", valores: { "31/12/2023": -1181543.26 } },
        { conta: "Lucro Bruto", valores: { "31/12/2023": -405652.28 }, subtotal: true },
        { conta: "EBITDA", valores: { "31/12/2023": -405652.28 }, subtotal: true },
      ],
      arvoreOriginalDRE: {
        "31/12/2023": [
          {
            nome: "(-) CUSTO DOS PRODUTOS/MERCADORIAS/SERVICOS", valor: -1181543.26, destino: "Custo Operacional",
            filhos: [
              {
                nome: "Custo das Mercadorias Vendidas", valor: 845786.98,
                filhos: [
                  { nome: "Compras de Mercadorias", valor: -2025762.91 },
                  { nome: "Perdas no Estoque de Mercadorias", valor: -42257.79 },
                  { nome: "(-) Devoluções de Compras de Mercadorias", valor: 20912.91 },
                  { nome: "(-) Créditos de ICMS", valor: 5386.27 },
                  { nome: "(-) Doações Bonificações", valor: 3914.96 },
                  { nome: "(-) Crédito PIS Lucro Real", valor: 4437.37 },
                  { nome: "(-) Crédito Cofins Lucro Real", valor: 11561.25 },
                ],
              },
              { nome: "Depreciações", valor: -5522.3 },
            ],
          },
        ],
      },
    };
    const abertura = derivarAberturaCustos(dados);
    expect(abertura).toHaveLength(9);
    const porConta = Object.fromEntries(abertura.map((a) => [a.conta, a.valores["31/12/2023"]]));
    // O CMV é linha REAL (a soma dos "filhos" não fecha com ele) e as netas também.
    expect(porConta["Custo das Mercadorias Vendidas"]).toBeCloseTo(845786.98, 2);
    expect(porConta["Compras de Mercadorias"]).toBeCloseTo(2025762.91, 2);
    expect(porConta["(-) Devoluções de Compras de Mercadorias"]).toBeCloseTo(20912.91, 2);
    expect(porConta["Depreciações"]).toBeCloseTo(5522.3, 2);
    // Prova de fechamento: as linhas (com sinal do documento) somam o total do bloco.
    const somaAssinada = 845786.98 - 2025762.91 - 42257.79 + 20912.91 + 5386.27 + 3914.96 + 4437.37 + 11561.25 - 5522.3;
    expect(somaAssinada).toBeCloseTo(-1181543.26, 2);
    // valoresAssinados preserva o SINAL do documento (redutoras positivas no
    // bloco negativo) — é dele que o seed tira o % negativo das redutoras.
    const porContaAssinado = Object.fromEntries(abertura.map((a) => [a.conta, a.valoresAssinados?.["31/12/2023"]]));
    expect(porContaAssinado["Compras de Mercadorias"]).toBeCloseTo(-2025762.91, 2);
    expect(porContaAssinado["(-) Devoluções de Compras de Mercadorias"]).toBeCloseTo(20912.91, 2);
    const somaViaAssinados = abertura.reduce((s, a) => s + (a.valoresAssinados?.["31/12/2023"] ?? 0), 0);
    expect(somaViaAssinados).toBeCloseTo(-1181543.26, 2);
  });

  // Decisão 2026-07-16: as VARIÁVEIS do valuation são as contas do MODELO
  // PADRÃO (o de-para já foi feito no fold) — não as contas originais do doc.
  it("abertura CANÔNICA: variáveis = contas do modelo padrão, com sinal", () => {
    const dados = {
      periodos: ["31/12/2023", "31/12/2024"],
      dre: [
        { conta: "Receita Bruta", valores: { "31/12/2023": 1000, "31/12/2024": 1200 } },
        { conta: "Receita Líquida", valores: { "31/12/2023": 950, "31/12/2024": 1140 }, subtotal: true },
        { conta: "Custo Operacional", valores: { "31/12/2023": -400, "31/12/2024": -500 } },
        { conta: "Lucro Bruto", valores: { "31/12/2023": 550, "31/12/2024": 640 }, subtotal: true },
        { conta: "Despesas com Pessoas", valores: { "31/12/2023": -90, "31/12/2024": -110 } },
        { conta: "Outras Receitas Operacionais", valores: { "31/12/2023": 30, "31/12/2024": 20 } },
        { conta: "EBITDA", valores: { "31/12/2023": 490, "31/12/2024": 550 }, subtotal: true },
      ],
      // Árvore presente NÃO muda nada: a abertura canônica ignora o documento.
      arvoreOriginalDRE: { "31/12/2023": [{ nome: "CMV do doc", valor: -400, destino: "Custo Operacional" }] },
    };
    const abertura = derivarAberturaCustosCanonica(dados);
    expect(abertura.map((a) => a.conta)).toEqual(["Custo Operacional", "Despesas com Pessoas", "Outras Receitas Operacionais"]);
    expect(abertura.map((a) => a.bloco)).toEqual(["custo", "despesa", "despesa"]);
    // Sinal preservado: linha POSITIVA no bloco (Outras Receitas Op.) é REDUTORA.
    expect(abertura[0].valoresAssinados).toEqual({ "31/12/2023": -400, "31/12/2024": -500 });
    expect(abertura[2].valoresAssinados).toEqual({ "31/12/2023": 30, "31/12/2024": 20 });
    expect(abertura[2].valores).toEqual({ "31/12/2023": 30, "31/12/2024": 20 });
  });

  // Grupo cujo total declarado NÃO fecha com os filhos capturados (o documento
  // neta linhas fora do texto — receita bruta da matriz Move Farma): a linha é o
  // PRÓPRIO grupo, com o valor que o fold contabilizou — nada duplicado.
  it("grupo que não fecha com os filhos vira linha única (valor do fold)", () => {
    const dados = {
      periodos: ["31/12/2023"],
      dre: dreCanonica({ "31/12/2023": 842167.29, "31/12/2024": 0 }),
      arvoreOriginalDRE: {
        "31/12/2023": [
          {
            nome: "RECEITA OPERACIONAL BRUTA", valor: 842167.29, destino: "Receita Bruta",
            filhos: [{ nome: "Vendas de Mercadorias", valor: 1798818.24 }],
          },
        ],
      },
    };
    const abertura = derivarAberturaReceita(dados);
    expect(abertura).toEqual([
      { conta: "RECEITA OPERACIONAL BRUTA", valores: { "31/12/2023": 842167.29 } },
    ]);
  });
});

/* ── REGRA DE PROJEÇÃO POR CONTA (decisão do usuário, 22/07/2026) ────────────
 * Custo fixo não acompanha faturamento: estas contas projetam por crescimento
 * PRÓPRIO (CAGR, com cascata) ou por IPCA — nunca como % da receita.
 */
describe("cagrDaSerie", () => {
  it("calcula o CAGR composto entre o primeiro e o último ponto", () => {
    // 100 → 121 em 2 anos = 10% a.a.
    expect(cagrDaSerie([100, 110, 121])).toBeCloseTo(0.1, 10);
  });

  it("devolve null quando não dá para computar (1 ponto, base zero ou negativa)", () => {
    expect(cagrDaSerie([100])).toBeNull();
    expect(cagrDaSerie([0, 100])).toBeNull();
    expect(cagrDaSerie([-50, 100])).toBeNull();
    expect(cagrDaSerie([100, 0])).toBeNull();
  });

  it("devolve CAGR negativo quando a conta encolheu (quem decide é a cascata)", () => {
    expect(cagrDaSerie([200, 100])).toBeCloseTo(-0.5, 10);
  });
});

describe("ultimoCrescimentoPositivo", () => {
  it("pega o crescimento positivo MAIS RECENTE, ignorando quedas posteriores", () => {
    // 100 →(+20%) 120 →(−25%) 90 : o último positivo é o de 100→120
    expect(ultimoCrescimentoPositivo([100, 120, 90])).toBeCloseTo(0.2, 10);
  });

  it("devolve null quando a série só cai", () => {
    expect(ultimoCrescimentoPositivo([300, 200, 100])).toBeNull();
  });
});

describe("regraDaConta", () => {
  it("aluguel e terceiros são contrato indexado — IPCA, sem opinião de crescimento", () => {
    for (const conta of ["Despesas com Aluguel, Condomínio e IPTU", "Despesas com Terceiros"]) {
      const r = regraDaConta(conta, [100, 500, 20]); // série irrelevante p/ a regra
      expect(r).not.toBeNull();
      expect(r!.reajusteIndice).toBe("ipca");
      expect(r!.reajusteAnual).toBeUndefined();
    }
  });

  it("custo fixo com histórico saudável projeta pelo CAGR próprio", () => {
    const r = regraDaConta("Despesas com Pessoas", [100, 110, 121]);
    expect(r!.modo).toBe("fixoReajuste");
    expect(r!.reajusteAnual).toBeCloseTo(0.1, 10);
    expect(r!.reajusteIndice).toBeUndefined();
    expect(r!.prova).toContain("CAGR próprio");
  });

  it("CAGR negativo cai para o último crescimento positivo (despesa não encolhe na projeção)", () => {
    // 100 →(+20%) 120 →(−25%) 90 : CAGR = −5,1% (negativo) → usa +20%
    const r = regraDaConta("Despesas com Veículos", [100, 120, 90]);
    expect(r!.reajusteAnual).toBeCloseTo(0.2, 10);
    expect(r!.prova).toContain("CAGR negativo");
  });

  it("série só decrescente, sem nenhum crescimento positivo, projeta por IPCA", () => {
    const r = regraDaConta("Despesas Gerais e Administrativas", [300, 200, 100]);
    expect(r!.reajusteIndice).toBe("ipca");
    expect(r!.reajusteAnual).toBeUndefined();
    expect(r!.prova).toContain("sem crescimento positivo");
  });

  it("CAGR acima do teto de sanidade não é usado (base pequena / ano atípico)", () => {
    // 10 → 1000 = 900% a.a., muito acima do teto
    const r = regraDaConta("Despesas com Veículos", [10, 1000]);
    expect(r!.reajusteAnual).toBeUndefined();
    expect(r!.reajusteIndice).toBe("ipca");
    expect(r!.prova).toContain("teto");
    expect(TETO_CRESCIMENTO_CONTA).toBe(0.5);
  });

  it("um único período não tem CAGR — projeta por IPCA em vez de inventar taxa", () => {
    const r = regraDaConta("Despesas com Limpeza, Manutenção e Reparos", [250]);
    expect(r!.reajusteIndice).toBe("ipca");
  });

  it("conta fora das listas devolve null (segue a heurística estatística de sempre)", () => {
    expect(regraDaConta("Despesas com Marketing", [100, 110])).toBeNull();
    expect(regraDaConta("Custo Operacional", [100, 110])).toBeNull();
  });

  it("casa o nome sem depender de acento, caixa ou espaço duplicado", () => {
    expect(regraDaConta("DESPESAS COM ENERGIA, AGUA, TELEFONE E INTERNET", [100, 110])).not.toBeNull();
    expect(regraDaConta("despesas  com   veiculos", [100, 110])).not.toBeNull();
    expect(normConta("Despesas com Veículos")).toBe("despesas com veiculos");
  });

  it("Outras Receitas/Despesas Operacionais entram na regra de crescimento próprio", () => {
    expect(regraDaConta("Outras Receitas Operacionais", [100, 110])!.reajusteAnual).toBeCloseTo(0.1, 10);
    expect(regraDaConta("Outras Despesas Operacionais", [100, 110])!.reajusteAnual).toBeCloseTo(0.1, 10);
  });
});
