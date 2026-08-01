/**
 * Testes da linha de extração de BALANCETE (F1) — fixtures SINTÉTICAS que
 * reproduzem a matriz de formatos do corpus real de 7 sistemas contábeis
 * (PDFs de clientes NÃO são commitados — LGPD). Validação contra os PDFs
 * reais roda localmente via scripts/valida-balancetes.ts.
 */
import { describe, it, expect } from "vitest";
import { parseBalanceteTexto } from "./balancete-parser";
import { converterBalancete, mesclarArvoresBalancete } from "./balancete-conversao";
import { mapAccountToBPGroup } from "./account-mapper";
import { parseBalanceteTabular, pareceBalanceteTabular, csvParaMatriz, ehArquivoTabular } from "./balancete-tabular";

// ── fixtures sintéticas ──────────────────────────────────────────────────────

/** Estilo Belagro/Questor: conta reduzida COLADA na classificação, sem D/C,
 *  valores assinados na convenção do grupo, folhas sem movimento. */
const FIX_COLADO = `
                          Balancete Consolidado de 01/05/2026 a 31/05/2026
                          Empresa: 185 - EXEMPLO LTDA
 ContaClassificação     Nome da conta contábil        Saldo anterior      Débito       Crédito      Saldo atual
    1901              ATIVO                             900,00        700,00        100,00       1.500,00
    2701.1               ATIVO CIRCULANTE               900,00        700,00        100,00       1.500,00
    3501.1.1               Caixa Geral                  900,00        700,00        100,00       1.500,00
   116302              PASSIVO                          800,00         50,00        150,00         900,00
   117102.1               PASSIVO CIRCULANTE            500,00         50,00        150,00         600,00
   120102.1.1               Fornecedores                500,00         50,00        150,00         600,00
   190202.3               PATRIMÔNIO LÍQUIDO            300,00          0,00          0,00         300,00
   195202.3.1               Capital Social              300,00          0,00          0,00         300,00
   208903              RECEITAS                         500,00          0,00        500,00       1.000,00
   209703.1               RECEITAS OPERACIONAIS         500,00          0,00        500,00       1.000,00
   210103.1.1               Venda de Mercadorias        450,00          0,00        500,00         950,00
   210203.1.2               Descontos Obtidos            50,00          0,00          0,00          50,00
   276304              CUSTOS E DESPESAS                400,00          0,00          0,00         400,00
   277104.1               CUSTOS                        400,00          0,00          0,00         400,00
   277904.1.1               Custo de Mercadorias        450,00          0,00          0,00         450,00
   278004.1.2               (-) Recuperação de Custos   -50,00          0,00          0,00         -50,00
 Total de débitos 750,00 Total de créditos 750,00
`;

/** Estilo Domínio: descrição GRUDADA no início de algumas linhas, sufixo D/C
 *  sem espaço, código + classificação limpa. */
const FIX_DOMINIO = `
Empresa:   EXEMPLO DOMINIO LTDA
Período:      01/01/2024 - 30/09/2024
                             BALANCETE
CódigoClassificação         Descrição da conta            Saldo Anterior       Débito      Crédito     Saldo Atual
      1 1                  ATIVO                              800,00D        900,00       500,00       1.200,00D
ATIVO CIRCULANTE2 1.1                    ATIVO CIRCULANTE    800,00D        900,00       500,00       1.200,00D
      3 1.1.1                     Bancos                     800,00D        900,00       500,00       1.200,00D
PASSIVO4 2                  PASSIVO                          700,00C         10,00       110,00         800,00C
      5 2.1                    Fornecedores                  700,00C         10,00       110,00         800,00C
      6 3                  RECEITAS                          600,00C          0,00       500,00       1.100,00C
      7 3.1                    Receita de Serviços           600,00C          0,00       500,00       1.100,00C
      8 4                  DESPESAS                          500,00D        200,00         0,00         700,00D
      9 4.1                    Despesas Gerais               500,00D        200,00         0,00         700,00D
`;

/** Estilo Pryor/Wolk (Sage): classificação corrida + coluna reduzida. */
const FIX_CORRIDA = `
               EXEMPLO SYSTEMS LTDA
Consolidação: Empresa      Grau: 5              Período:               12/2020 a 12/2020
Conta        Reduzida Nome                        Saldo Anterior        Débito       Crédito       Saldo Atual
1                         ATIVO                       500,00        800,00        300,00        1.000,00
11                         CIRCULANTE                 500,00        800,00        300,00        1.000,00
111                          DISPONIVEL               500,00        800,00        300,00        1.000,00
11101001               1-9        CAIXA               500,00        800,00        300,00        1.000,00
2                         PASSIVO                     400,00         20,00       220,00           600,00
21                         CIRCULANTE                 400,00         20,00       220,00           600,00
21101001               2-2        FORNECEDORES        400,00         20,00       220,00           600,00
3                         RECEITA                     700,00          0,00       500,00         1.200,00
31                         VENDAS                     700,00          0,00       500,00         1.200,00
31101001               3-1        VENDA PRODUTOS      700,00          0,00       500,00         1.200,00
4                         DESPESAS                    600,00        200,00         0,00           800,00
41                         GERAIS                     600,00        200,00         0,00           800,00
41101001               4-5        SALARIOS            600,00        200,00         0,00           800,00
`;

/** Estilo Phonetrack/Tango: S de sintética COLADO na classificação, nomes
 *  espaçados, grupo de apuração cujas folhas são "resultado do exercício". */
const FIX_S_COLADO = `
1702  EXEMPLO S A
                                                       Período: 01/12/2023 a 31/12/2023
                                  BALANCETE
  Conta  SClassificação                Saldo Ant.        Débito      Crédito        Saldo
      10000   S1   A T I V O               600,00        500,00        100,00        1.000,00
      19990   S1.01   ATIVO CIRCULANTE     600,00        500,00        100,00        1.000,00
      19981   S1.01.01   CAIXA GERAL       600,00        500,00        100,00        1.000,00
      20000   S2   P A S S I V O           500,00         10,00        110,00          600,00
      29990   S2.01   FORNECEDORES         500,00         10,00        110,00          600,00
      30000   S3   RECEITAS                500,00          0,00        400,00          900,00
      39990   S3.01   VENDAS               500,00          0,00        400,00          900,00
      50000   S5   DESPESAS                300,00        200,00          0,00          500,00
      59990   S5.01   SALARIOS             300,00        200,00          0,00          500,00
      60000   S6   RESULTADO               100,00          0,00          0,00          100,00
      69990   S6.01   RESULTADO DO EXERCICIO  100,00      0,00          0,00          100,00
`;

/** Estilo Protheus (SIGA): pipes, 5 colunas (Ant·D·C·Movimento·Atual), D/C
 *  com espaço, e o padrão de DUPLA CONTAGEM: folha sintética "3.2.15" cujos
 *  filhos reais "3.2.21.xx" não compartilham prefixo. */
const FIX_PROTHEUS = `
SIGA /CTBR040/v.12       Parâmetros - BALANCETE DE VERIFICACAO DE 01/12/2023 ATE 31/12/2023, EM REAL
|  CODIGO         |      D E S C R I C A O           |    SALDO ANTERIOR   |     DEBITO   |      CREDITO  |    MOVIMENTO DO PERIODO  |         SALDO ATUAL      |
|1                | ATIVO                            |     900,00 D        |   700,00     |   100,00      |      600,00 D            |     1.500,00 D           |
|1.1              | CIRCULANTE                       |     900,00 D        |   700,00     |   100,00      |      600,00 D            |     1.500,00 D           |
|1.1.1            | DISPONIVEL                       |     900,00 D        |   700,00     |   100,00      |      600,00 D            |     1.500,00 D           |
|1.1.11           | CAIXA                            |     900,00 D        |   700,00     |   100,00      |      600,00 D            |     1.500,00 D           |
|2                | PASSIVO                          |     800,00 C        |    50,00     |   150,00      |      100,00 C            |       900,00 C           |
|2.1              | FORNECEDORES                     |     800,00 C        |    50,00     |   150,00      |      100,00 C            |       900,00 C           |
|3                | RECEITA LIQUIDA                  |     700,00 C        |   100,00     |   500,00      |      400,00 C            |     1.100,00 C           |
|3.1              | RECEITA BRUTA                    |     900,00 C        |     0,00     |   500,00      |      500,00 C            |     1.400,00 C           |
|3.2              | (-) DEDUCOES                     |     200,00 D        |   100,00     |     0,00      |      100,00 D            |       300,00 D           |
|3.2.15           | (-) IMPOSTOS SOBRE VENDA         |     200,00 D        |   100,00     |     0,00      |      100,00 D            |       300,00 D           |
|  3.2.21.01      | (-) ICMS                         |     150,00 D        |    80,00     |     0,00      |       80,00 D            |       230,00 D           |
|  3.2.21.02      | (-) PIS                          |      50,00 D        |    20,00     |     0,00      |       20,00 D            |        70,00 D           |
|4                | CUSTOS                           |     400,00 D        |   100,00     |     0,00      |      100,00 D            |       500,00 D           |
|4.1              | CUSTO MERCADORIAS                |     400,00 D        |   100,00     |     0,00      |      100,00 D            |       500,00 D           |
`;

/** Exercício ENCERRADO: contas de resultado zeradas via apuração, A = P;
 *  DRE deve sair do MOVIMENTO excluindo o grupo de apuração. */
const FIX_ENCERRADO = `
Empresa:   EXEMPLO ENCERRADO LTDA
Período:      01/01/2024 - 31/12/2024
                             BALANCETE
CódigoClassificação         Descrição da conta          Saldo Anterior       Débito      Crédito     Saldo Atual
      1 1                  ATIVO                            800,00D        700,00       300,00       1.200,00D
      2 1.1                    Bancos                       800,00D        700,00       300,00       1.200,00D
      3 2                  PASSIVO                          800,00C        300,00       700,00       1.200,00D
      4 2.1                    Fornecedores                 500,00C          0,00       100,00         600,00C
      5 2.2                    PATRIMONIO LIQUIDO           300,00C        300,00       600,00         600,00C
      6 3                  RECEITAS                           0,00       1.000,00     1.000,00           0,00
      7 3.1                    Receita de Vendas              0,00       1.000,00     1.000,00           0,00
      8 4                  DESPESAS                           0,00         700,00       700,00           0,00
      9 4.1                    Despesas Gerais                0,00         700,00       700,00           0,00
     10 5                  CONTAS DE APURACAO                 0,00       1.700,00     1.700,00           0,00
     11 5.1                    Apuracao do Resultado          0,00       1.700,00     1.700,00           0,00
`;

// ── parser ───────────────────────────────────────────────────────────────────

describe("parseBalanceteTexto — matriz de formatos", () => {
  it("estilo colado (Belagro): separa conta reduzida da classificação", () => {
    const p = parseBalanceteTexto(FIX_COLADO);
    expect(p.periodoInicio).toBe("01/05/2026");
    expect(p.periodoFim).toBe("31/05/2026");
    expect(p.linhas.map((l) => l.classificacao)).toContain("1.1.1");
    const caixa = p.linhas.find((l) => l.classificacao === "1.1.1");
    expect(caixa?.nome).toBe("Caixa Geral");
    expect(caixa?.saldoAtual).toBe(1500);
    // raiz não pontilhada "1901" → conta 190 + raiz "1"
    expect(p.linhas[0].classificacao).toBe("1");
    expect(p.linhas[0].nome).toBe("ATIVO");
    expect(p.totais).toEqual({ debito: 750, credito: 750 });
  });

  it("estilo colado: valor negativo assinado é preservado", () => {
    const p = parseBalanceteTexto(FIX_COLADO);
    const recup = p.linhas.find((l) => l.nome.includes("Recuperação"));
    expect(recup?.saldoAtual).toBe(-50);
  });

  it("estilo Domínio: descrição grudada no início não engole a linha", () => {
    const p = parseBalanceteTexto(FIX_DOMINIO);
    const passivo = p.linhas.find((l) => l.classificacao === "2");
    expect(passivo?.nome).toBe("PASSIVO");
    expect(passivo?.saldoAtual).toBe(800);
    expect(passivo?.naturezaAtual).toBe("C");
    const ac = p.linhas.find((l) => l.classificacao === "1.1");
    expect(ac?.nome).toBe("ATIVO CIRCULANTE");
  });

  it("estilo corrida (Pryor/Wolk): classificação por comprimento + reduzida descartada", () => {
    const p = parseBalanceteTexto(FIX_CORRIDA);
    const caixa = p.linhas.find((l) => l.classificacao === "11101001");
    expect(caixa?.nome).toBe("CAIXA");
    expect(caixa?.nivel).toBe(4); // comprimentos 1 < 2 < 3 < 8
    expect(p.linhas.find((l) => l.classificacao === "1")?.nivel).toBe(1);
  });

  it("estilo S colado (Phonetrack/Tango): sintética marcada e nome espaçado colapsado", () => {
    const p = parseBalanceteTexto(FIX_S_COLADO);
    const ativo = p.linhas.find((l) => l.classificacao === "1");
    expect(ativo?.nome).toBe("ATIVO"); // "A T I V O" colapsado
    expect(ativo?.sintetica).toBe(true);
    const caixa = p.linhas.find((l) => l.classificacao === "1.01.01");
    expect(caixa?.nome).toBe("CAIXA GERAL");
  });

  it("estilo Protheus: 5 colunas com movimento descartado + pipes", () => {
    const p = parseBalanceteTexto(FIX_PROTHEUS);
    const caixa = p.linhas.find((l) => l.classificacao === "1.1.11");
    expect(caixa?.saldoAnterior).toBe(900);
    expect(caixa?.debito).toBe(700);
    expect(caixa?.credito).toBe(100);
    expect(caixa?.saldoAtual).toBe(1500); // movimento (600) descartado
    expect(caixa?.naturezaAtual).toBe("D");
  });
});

// ── conversão + provas ───────────────────────────────────────────────────────

describe("converterBalancete — provas de integridade", () => {
  it("colado: fechamento ao centavo com folhas SEM movimento (herança de convenção)", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_COLADO));
    // Receitas: 950 + 50 (Descontos Obtidos, sem movimento, grupo credor) = 1.000
    // Custos: 450 − 50 (Recuperação, negativa no grupo devedor) = 400
    expect(conv.resultadoAcumulado).toBe(600);
    expect(conv.provas.fechamento.ok).toBe(true);
    expect(conv.provas.fechamento.delta).toBe(0);
    expect(conv.provas.debitosCreditos?.ok).toBe(true);
  });

  it("colado: BP tem PL ajustado com Resultado do Período", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_COLADO));
    const bp = conv.arvoreBP["31/05/2026"];
    expect(bp).toBeDefined();
    const pl = bp.grupos["Patrimônio Líquido"];
    expect(pl?.some((i) => i.nome.includes("Resultado do Período") && i.valor === 600)).toBe(true);
    // Ativo = Passivo ajustado: 1.500 = 900 + 600
    const somaAtivo = Object.entries(bp.grupos)
      .filter(([k]) => k.toUpperCase().includes("ATIVO"))
      .flatMap(([, itens]) => itens)
      .reduce((s, i) => s + i.valor, 0);
    expect(somaAtivo).toBe(1500);
  });

  it("colado: gera retrato de ABERTURA no dia anterior ao início", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_COLADO));
    expect(conv.periodoBPAnterior).toBe("30/04/2026");
    expect(conv.arvoreBP["30/04/2026"]).toBeDefined();
  });

  it("Domínio: fechamento com sufixo D/C", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_DOMINIO));
    // A 1.200 − P 800 = R 400 (receitas 1.100 − despesas 700)
    expect(conv.resultadoAcumulado).toBe(400);
    expect(conv.provas.fechamento.ok).toBe(true);
  });

  it("corrida: fechamento sem D/C nem sinais (equação do documento)", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_CORRIDA));
    // A 1.000 − P 600 = R 400 (1.200 − 800)
    expect(conv.resultadoAcumulado).toBe(400);
    expect(conv.provas.fechamento.ok).toBe(true);
  });

  it("S colado: grupo de apuração NÃO entra na DRE", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_S_COLADO));
    // R 900 − D 500 = 400 (grupo 6 RESULTADO/apuração excluído)
    expect(conv.resultadoAcumulado).toBe(400);
    expect(conv.provas.fechamento.ok).toBe(true);
    const dre = conv.arvoreDRE["31/12/2023"] ?? [];
    const nomes = JSON.stringify(dre);
    expect(nomes).not.toContain("RESULTADO DO EXERCICIO");
  });

  it("Protheus: reparo de dupla contagem (3.2.15 pai real de 3.2.21.xx)", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_PROTHEUS));
    // R = 1.400 − 300 (deduções UMA vez) − 500 (custos) = 600 = A 1.500 − P 900
    expect(conv.resultadoAcumulado).toBe(600);
    expect(conv.provas.fechamento.ok).toBe(true);
  });

  it("exercício encerrado: A = P e DRE sai do movimento sem apuração", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_ENCERRADO));
    expect(conv.provas.exercicioEncerrado).toBe(true);
    expect(conv.provas.fechamento.ok).toBe(true);
    const dre = conv.arvoreDRE["31/12/2024"] ?? [];
    const total = dre.reduce((s, i) => s + i.valor, 0);
    expect(total).toBe(300); // receitas 1.000 − despesas 700, apuração fora
    expect(JSON.stringify(dre)).not.toContain("Apuracao");
  });

  it("DRE YTD assinada: receitas positivas, despesas negativas", () => {
    const conv = converterBalancete(parseBalanceteTexto(FIX_DOMINIO));
    const dre = conv.arvoreDRE["30/09/2024"] ?? [];
    const receitas = dre.find((i) => i.nome.toUpperCase().includes("RECEITA"));
    const despesas = dre.find((i) => i.nome.toUpperCase().includes("DESPESA"));
    expect(receitas?.valor).toBe(1100);
    expect(despesas?.valor).toBe(-700);
  });

  it("plug do PL ('Resultado do Período') mapeia para 'Resultado do Exercício' — nunca fica pendente", () => {
    // O valor calculado que fecha o balanço não é conta do documento e não pode
    // virar pendência de classificação. Alias em financial-templates → o fold o
    // resolve para a linha de resultado do PL (integração provada no E2E Belagro).
    expect(mapAccountToBPGroup("Resultado do Período (apuração do balancete)", "PL")).toBe("Resultado do Exercício");
    // A conversão injeta o plug com o nome-âncora do alias (exercício EM CURSO).
    const conv = converterBalancete(parseBalanceteTexto(FIX_DOMINIO));
    const pl = Object.values(conv.arvoreBP[conv.periodoBP].grupos).flat();
    expect(pl.some((i) => /apura[çc][ãa]o do balancete/i.test(i.nome))).toBe(true);
  });
});

describe("mesclarArvoresBalancete (leitura: auditoria do IBR e Valuation)", () => {
  const dadosBalanceteOnly = () => ({
    arvoreOriginalBP: undefined as unknown,
    arvoreOriginalDRE: undefined as unknown,
    arvoresBalancete: [
      { periodo: "31/05/2026", arvoreBP: { "31/05/2026": { grupos: {} } }, arvoreDRE: { "31/05/2026": [] } },
    ],
  });

  it("IBR só de balancete: as árvores mensais passam a aparecer em arvoreOriginalBP/DRE", () => {
    const d = mesclarArvoresBalancete(dadosBalanceteOnly());
    expect(Object.keys(d.arvoreOriginalBP as object)).toEqual(["31/05/2026"]);
    expect(Object.keys(d.arvoreOriginalDRE as object)).toEqual(["31/05/2026"]);
  });

  it("não sobrescreve período ANUAL já existente (o balancete só preenche vazio)", () => {
    const anual = { "31/12/2025": { grupos: { ANUAL: [] } } };
    const d = mesclarArvoresBalancete({
      arvoreOriginalBP: { ...anual } as unknown,
      arvoreOriginalDRE: undefined as unknown,
      arvoresBalancete: [
        { periodo: "31/12/2025", arvoreBP: { "31/12/2025": { grupos: { MENSAL: [] } } }, arvoreDRE: {} },
      ],
    });
    const bp = d.arvoreOriginalBP as Record<string, { grupos: Record<string, unknown> }>;
    expect(Object.keys(bp["31/12/2025"].grupos)).toEqual(["ANUAL"]);
  });

  it("sem balancetes, devolve os dados intactos", () => {
    const orig = { arvoreOriginalBP: { a: 1 } as unknown, arvoreOriginalDRE: undefined as unknown, arvoresBalancete: [] };
    expect(mesclarArvoresBalancete(orig).arvoreOriginalBP).toEqual({ a: 1 });
  });

  // CASO BELAGRO (31/07/2026): fevereiro aparecia SEM destino nenhum na auditoria.
  // O balancete de MARÇO carrega a foto de 28/02 na coluna "saldo anterior"; como
  // ele foi mesclado primeiro, ocupou a chave do mês — e essa foto não é dobrada.
  it("mês com documento PRÓPRIO vence a foto de saldo anterior de outro mês", () => {
    const d = mesclarArvoresBalancete({
      arvoreOriginalBP: undefined as unknown,
      arvoreOriginalDRE: undefined as unknown,
      arvoresBalancete: [
        // março chega ANTES e traz 28/02 como saldo anterior (não dobrado)
        { periodo: "31/03/2026", arvoreBP: { "31/03/2026": { grupos: { MARCO: [] } }, "28/02/2026": { grupos: { ANTERIOR_DE_MARCO: [] } } }, arvoreDRE: { "31/03/2026": [] } },
        // fevereiro tem documento próprio: é ele quem manda em 28/02
        { periodo: "28/02/2026", arvoreBP: { "28/02/2026": { grupos: { FEVEREIRO: [] } }, "31/01/2026": { grupos: { ANTERIOR_DE_FEV: [] } } }, arvoreDRE: { "28/02/2026": [] } },
      ],
    });
    const bp = d.arvoreOriginalBP as Record<string, { grupos: Record<string, unknown> }>;
    expect(Object.keys(bp["28/02/2026"].grupos)).toEqual(["FEVEREIRO"]);
    expect(Object.keys(bp["31/03/2026"].grupos)).toEqual(["MARCO"]);
    // 31/01 não tem documento próprio — segue vindo do saldo anterior de fevereiro
    expect(Object.keys(bp["31/01/2026"].grupos)).toEqual(["ANTERIOR_DE_FEV"]);
  });
});

// ── VIA TABULAR (CSV/Excel) — 31/07/2026 ─────────────────────────────────────
// A planilha DECLARA as colunas no cabeçalho (o PDF obriga a inferir do
// layout). Mesmo contrato de saída ⇒ conversão, provas e fold não mudam.

describe("balancete tabular (CSV/Excel)", () => {
  /** Estilo Domínio/Belagro: ';', colunas nomeadas, negativo entre parênteses. */
  const CSV_DOMINIO = [
    "Balancete Consolidado de 01/04/2026 a 30/04/2026;;;;;;",
    "Empresa: 185 - EXEMPLO LTDA - CNPJ:00.000.000/0001-00",
    "",
    "Conta;Classificação;Nome da conta contábil;Saldo anterior;Débito;Crédito;Saldo atual",
    "",
    // Mês coerente: vendas +500, despesas +300, caixa +700/−100, fornecedores
    // +450/−50. Fecha nos DOIS retratos (atual: 1.500−1.200=300=1.000−700;
    // anterior: 900−800=100=500−400).
    "19;01;ATIVO;900,00;700,00;100,00;1.500,00",
    "27;01.1;ATIVO CIRCULANTE;900,00;700,00;100,00;1.500,00",
    "35;01.1.1;Caixa Geral;900,00;700,00;100,00;1.500,00",
    "40;01.1.2;Clientes;0,00;0,00;0,00;(0,00)",
    "1163;02;PASSIVO;800,00;50,00;450,00;1.200,00",
    "1171;02.1;PASSIVO CIRCULANTE;500,00;50,00;450,00;900,00",
    "1201;02.1.1;Fornecedores;500,00;50,00;450,00;900,00",
    "1902;02.3;PATRIMÔNIO LÍQUIDO;300,00;0,00;0,00;300,00",
    "1952;02.3.1;Capital Social;300,00;0,00;0,00;300,00",
    "2089;03;RECEITAS;500,00;0,00;500,00;1.000,00",
    "2097;03.1;RECEITAS OPERACIONAIS;500,00;0,00;500,00;1.000,00",
    "2101;03.1.1;Venda de Mercadorias;500,00;0,00;500,00;1.000,00",
    "3000;04;DESPESAS;400,00;300,00;0,00;700,00",
    "3100;04.1;DESPESAS OPERACIONAIS;400,00;300,00;0,00;700,00",
    "3101;04.1.1;Aluguéis;400,00;300,00;0,00;700,00",
  ].join("\r\n");

  const buf = (s: string, enc: BufferEncoding = "utf8") => Buffer.from(s, enc);

  it("lê o layout Domínio: período, contas, hierarquia e negativo entre parênteses", () => {
    const p = parseBalanceteTabular(buf(CSV_DOMINIO), "Balancete 04.2026.csv");
    expect(p.periodoInicio).toBe("01/04/2026");
    expect(p.periodoFim).toBe("30/04/2026");
    expect(p.avisos).toEqual([]);
    expect(p.linhas).toHaveLength(15);
    const caixa = p.linhas.find((l) => l.nome === "Caixa Geral")!;
    expect(caixa.classificacao).toBe("01.1.1");
    expect(caixa.nivel).toBe(3); // profundidade pela classificação pontilhada
    expect(caixa.saldoAnterior).toBe(900);
    expect(caixa.debito).toBe(700);
    expect(caixa.saldoAtual).toBe(1500);
    expect(p.linhas.find((l) => l.nome === "ATIVO")!.nivel).toBe(1);
  });

  it("o balanço fecha ao centavo pela MESMA conversão do PDF", () => {
    const c = converterBalancete(parseBalanceteTabular(buf(CSV_DOMINIO), "b.csv"));
    expect(c.periodoBP).toBe("30/04/2026");
    expect(c.provas.fechamento.ok).toBe(true);
    expect(c.provas.fechamento.delta).toBe(0);
    // ativo 1.500 − passivo 900 = resultado do período (receita 1.000 − despesa 700 = 300)
    expect(c.provas.fechamento.ativo).toBe(1500);
    expect(c.provas.fechamento.resultadoAcumulado).toBe(300);
  });

  it("acento sobrevive ao ANSI do ERP (Windows-1252), não vira '\uFFFD'", () => {
    const p = parseBalanceteTabular(buf(CSV_DOMINIO, "latin1"), "b.csv");
    expect(p.linhas.map((l) => l.nome)).toContain("Aluguéis");
    expect(p.linhas.some((l) => l.nome.includes("\uFFFD"))).toBe(false);
  });

  it("colunas em ORDEM DIFERENTE: mapeia pelo nome do cabeçalho, não pela posição", () => {
    const trocado = [
      "Balancete de 01/04/2026 a 30/04/2026",
      "Classificação;Nome da conta contábil;Saldo atual;Saldo anterior;Débito;Crédito",
      "01;ATIVO;1.500,00;900,00;700,00;100,00",
      "01.1;ATIVO CIRCULANTE;1.500,00;900,00;700,00;100,00",
      "01.1.1;Caixa Geral;1.500,00;900,00;700,00;100,00",
    ].join("\n");
    const l = parseBalanceteTabular(buf(trocado), "b.csv").linhas.find((x) => x.nome === "Caixa Geral")!;
    expect(l.saldoAtual).toBe(1500);
    expect(l.saldoAnterior).toBe(900);
    expect(l.debito).toBe(700);
    expect(l.credito).toBe(100);
  });

  it("separador vírgula com campo entre aspas (o ';' não é obrigatório)", () => {
    const virgula = [
      "Balancete de 01/04/2026 a 30/04/2026",
      "Classificação,Nome da conta contábil,Saldo anterior,Débito,Crédito,Saldo atual",
      '01,ATIVO,"900,00","700,00","100,00","1.500,00"',
      '01.1,"Caixa, cofre e bancos","900,00","700,00","100,00","1.500,00"',
    ].join("\n");
    const p = parseBalanceteTabular(buf(virgula), "b.csv");
    expect(p.linhas.find((l) => l.nome === "Caixa, cofre e bancos")?.saldoAtual).toBe(1500);
  });

  it("sniff pelo CONTEÚDO: planilha de balancete é reconhecida; outra planilha não", () => {
    expect(pareceBalanceteTabular(csvParaMatriz(buf(CSV_DOMINIO))).balancete).toBe(true);
    const orcamento = ["Conta;Jan;Fev;Mar", "Receita;100,00;200,00;300,00"].join("\n");
    expect(pareceBalanceteTabular(csvParaMatriz(buf(orcamento))).balancete).toBe(false);
  });

  it("planilha sem cabeçalho de balancete avisa em vez de estourar", () => {
    const p = parseBalanceteTabular(buf("qualquer coisa;sem colunas"), "b.csv");
    expect(p.linhas).toHaveLength(0);
    expect(p.avisos.join(" ")).toMatch(/cabeçalho de balancete não encontrado/i);
  });

  it("reconhece as extensões da via tabular (e não sequestra o PDF)", () => {
    expect(ehArquivoTabular("Balancete 04.2026.csv")).toBe(true);
    expect(ehArquivoTabular("Balancete.XLSX")).toBe(true);
    expect(ehArquivoTabular("Balancete 04.2026.pdf")).toBe(false);
  });
});

// ── VALOR COLADO AO NOME (31/07/2026) ────────────────────────────────────────
// Caso Belagro, achado ao cruzar o PDF com o CSV do mesmo mês: nome terminado
// em dígitos grudados no 1º valor fazia a regex casar o número MAIS LONGO
// (318.170.427,68 no lugar de 8.170.427,68 — 310 milhões a mais no saldo
// anterior, em silêncio: o saldo atual e as provas de fechamento não sentem).
describe("balancete PDF — primeiro valor COLADO ao nome da conta", () => {
  const doc = (linhaConta: string) => `
                    Balancete Consolidado de 01/04/2026 a 30/04/2026
 Conta  Classificação   Nome da conta contábil     Saldo anterior    Débito     Crédito    Saldo atual
${linhaConta}
`;

  it("a EQUAÇÃO do documento desempata: nome fica inteiro e o saldo anterior é o certo", () => {
    // credora: 8.170.427,68 + 105.797,46 − 0 = 8.276.225,14 ✓
    // (com 318.170.427,68 daria 318.276.225,14 ✗)
    const l = parseBalanceteTexto(doc(
      "  10017902.1.2.01.032  Empréstimo NCE/CCE - CEF - 27105318.170.427,68        0,00   105.797,46   8.276.225,14",
    )).linhas[0];
    expect(l.nome).toBe("Empréstimo NCE/CCE - CEF - 2710531");
    expect(l.saldoAnterior).toBe(8170427.68);
    expect(l.saldoAtual).toBe(8276225.14);
  });

  it("valor grande LEGÍTIMO colado não é encurtado (a leitura longa já fecha)", () => {
    // devedora: 318.170.427,68 + 105.797,46 − 0 = 318.276.225,14 ✓ → nada muda
    const l = parseBalanceteTexto(doc(
      "  10017901.1.2.01.032  Conta com valor alto - 27105318.170.427,68   105.797,46        0,00 318.276.225,14",
    )).linhas[0];
    expect(l.saldoAnterior).toBe(318170427.68);
    expect(l.nome).toBe("Conta com valor alto - 27105");
  });

  it("linha SEM colagem (espaço antes do valor) segue intocada", () => {
    const l = parseBalanceteTexto(doc(
      "  10017901.1.2.01.032  Conta normal   900,00   700,00   100,00   1.500,00",
    )).linhas[0];
    expect(l.nome).toBe("Conta normal");
    expect(l.saldoAnterior).toBe(900);
    expect(l.saldoAtual).toBe(1500);
  });

  it("colado mas SEM alternativa que feche: mantém o comportamento de hoje", () => {
    const l = parseBalanceteTexto(doc(
      "  10017901.1.2.01.032  Conta incoerente - 27105318.170.427,68   1,00   2,00   99.999,99",
    )).linhas[0];
    expect(l.saldoAnterior).toBe(318170427.68);
    expect(l.saldoAtual).toBe(99999.99);
  });
});

// ── P3: cada conta fecha na PRÓPRIA equação ──────────────────────────────────
// P1/P2 olham só a coluna do saldo ATUAL — um saldo anterior corrompido passava
// com selo verde de 100% (caso Belagro: 310 milhões inflados por valor colado).
describe("P3 — coerência de cada linha do balancete", () => {
  it("vale nos 7 sistemas do corpus: nenhum falso alarme", () => {
    for (const [nome, fix] of Object.entries({ FIX_COLADO, FIX_DOMINIO, FIX_CORRIDA, FIX_S_COLADO, FIX_PROTHEUS })) {
      const c = converterBalancete(parseBalanceteTexto(fix));
      expect(`${nome}: ${c.provas.linhas.coerentes}/${c.provas.linhas.total}`)
        .toBe(`${nome}: ${c.provas.linhas.total}/${c.provas.linhas.total}`);
      expect(c.provas.linhas.ok).toBe(true);
    }
  });

  it("pega a coluna que P1/P2 não olham: saldo anterior corrompido derruba a prova", () => {
    // fechamento (saldo ATUAL) intacto — só o saldo ANTERIOR está inflado
    const corrompido = FIX_COLADO.replace(
      "    3501.1.1               Caixa Geral                  900,00        700,00        100,00       1.500,00",
      "    3501.1.1               Caixa Geral              310.900,00        700,00        100,00       1.500,00",
    );
    const c = converterBalancete(parseBalanceteTexto(corrompido));
    expect(c.provas.fechamento.ok).toBe(true);   // P2 continua passando…
    expect(c.provas.linhas.ok).toBe(false);      // …e P3 acusa
    expect(c.provas.linhas.incoerentes[0].nome).toBe("Caixa Geral");
    expect(c.avisos.join(" ")).toMatch(/não fecham na própria equação/i);
  });
});

// ── CORPUS Excel_Quantua (01/08/2026): 4 formatos novos de planilha ──────────
describe("balancete tabular — formatos do corpus de clientes", () => {
  const buf = (s: string) => Buffer.from(s, "utf8");

  it("TANGO: classificação e nome na MESMA célula, coluna S, dados desalinhados do cabeçalho", () => {
    const csv = [
      '"Período: 01/12/2022 a 31/12/2022"',
      '"BALANCETE";"Valores expressos em Reais (R$)"',
      '"Conta";"S";"Classificação";"Saldo Ant.";"Débito";"Crédito";"Saldo"',
      '"";"";"10000";"S";"1   A T I V O";"900,00";"";"700,00";"100,00";"1.500,00"',
      '"";"";"19990";"S";"1.01   ATIVO CIRCULANTE";"900,00";"";"700,00";"100,00";"1.500,00"',
      '"";"";"19981";"";"1.01.01   Caixa Geral";"900,00";"";"700,00";"100,00";"1.500,00"',
      '"";"";"20000";"S";"2   P A S S I V O";"800,00";"";"50,00";"450,00";"1.200,00"',
      '"";"";"20010";"";"2.01   Fornecedores";"500,00";"";"50,00";"450,00";"900,00"',
      '"";"";"20020";"";"2.02   Capital Social";"300,00";"";"0,00";"0,00";"300,00"',
      '"";"";"30000";"S";"3   RECEITAS";"500,00";"";"0,00";"500,00";"1.000,00"',
      '"";"";"30010";"";"3.01   Vendas";"500,00";"";"0,00";"500,00";"1.000,00"',
      '"";"";"40000";"S";"4   DESPESAS";"400,00";"";"300,00";"0,00";"700,00"',
      '"";"";"40010";"";"4.01   Aluguéis";"400,00";"";"300,00";"0,00";"700,00"',
    ].join("\r\n");
    const p = parseBalanceteTabular(buf(csv), "b.csv");
    expect(p.periodoFim).toBe("31/12/2022");
    expect(p.linhas).toHaveLength(10);
    const ativo = p.linhas[0];
    expect(ativo.nome).toBe("ATIVO"); // "A T I V O" colapsado
    expect(ativo.sintetica).toBe(true);
    expect(ativo.saldoAnterior).toBe(900);
    expect(ativo.saldoAtual).toBe(1500);
    const c = converterBalancete(p);
    expect(c.provas.fechamento.ok).toBe(true);
    expect(c.provas.linhas.ok).toBe(true);
  });

  it("EXTRAMED: natureza colada ('1.500,00D'), conta que VIRA de natureza fecha no P3 assinado", () => {
    const csv = [
      "Classificação;Conta;Nome;Saldo Anterior;Débito;Crédito;Saldo Atual",
      "1;10;ATIVO;900,00D;700,00;100,00;1.500,00D",
      "1.1;20;Caixa;900,00D;700,00;100,00;1.500,00D",
      "2;30;PASSIVO;500,00C;20,00;620,00;1.100,00C",
      // conta que começa CREDORA e termina DEVEDORA: -200 + 800 - 500 = +100 ✓
      "2.1;40;Adiantamento que virou;200,00C;800,00;500,00;100,00D",
      "2.2;50;Fornecedores;300,00C;20,00;120,00;400,00C",
      "2.3;60;Capital;0,00C;0,00;800,00;800,00C",
      "3;70;RECEITAS;500,00C;0,00;500,00;1.000,00C",
      "3.1;80;Vendas;500,00C;0,00;500,00;1.000,00C",
      "4;90;DESPESAS;400,00D;200,00;0,00;600,00D",
      "4.1;91;Salários;400,00D;200,00;0,00;600,00D",
    ].join("\n");
    const p = parseBalanceteTabular(buf(csv), "b.csv", "2022");
    const vira = p.linhas.find((l) => l.nome === "Adiantamento que virou")!;
    expect(vira.naturezaAnterior).toBe("C");
    expect(vira.naturezaAtual).toBe("D");
    const c = converterBalancete(p);
    expect(c.provas.linhas.ok).toBe(true); // P3 assinado aprova a virada
    expect(p.periodoFim).toBe("31/12/2022"); // período veio da competência
  });

  it("DESTINAÇÃO com saldo vivo: integrada ao resultado SÓ quando é o que fecha o balanço", () => {
    const csv = [
      "Classificação;Conta;Nome;Saldo Anterior;Débito;Crédito;Saldo Atual",
      "1;10;ATIVO;0,00D;1.000,00;0,00;1.000,00D",
      "1.1;20;Caixa;0,00D;1.000,00;0,00;1.000,00D",
      "2;30;PASSIVO;0,00C;0,00;700,00;700,00C",
      "2.1;40;Capital;0,00C;0,00;700,00;700,00C",
      "3;50;RECEITAS;0,00C;0,00;500,00;500,00C",
      "3.1;60;Vendas;0,00C;0,00;500,00;500,00C",
      "6;70;CONTAS DE DESTINACAO/APURACAO DE RESULTADO;0,00D;200,00;0,00;200,00D",
      "6.1;80;Distribuição de lucros;0,00D;200,00;0,00;200,00D",
    ].join("\n");
    // A−P = 300; resultado puro = 500; com destinação (−200) = 300 ✓
    const c = converterBalancete(parseBalanceteTabular(buf(csv), "b.csv", "2022"));
    expect(c.provas.fechamento.ok).toBe(true);
    expect(c.provas.fechamento.resultadoAcumulado).toBe(300);
    expect(c.avisos.join(" ")).toMatch(/destinação\/apuração de resultado .* integrado/i);
  });

  it("ENCERRAMENTO: coluna 'Conta' corrida, Movimento ignorado e saldo zerado em BRANCO", () => {
    const csv = [
      "Conta;Descricao;Saldo anterior;Debito;Credito;Mov  periodo;Saldo atual",
      "1;ATIVO;900,00 D;700.00;100.00;600,00 D;1.500,00 D",
      "11;CIRCULANTE;900,00 D;700.00;100.00;600,00 D;1.500,00 D",
      "111;Caixa Geral;900,00 D;700.00;100.00;600,00 D;1.500,00 D",
      // saldo final ZERADO impresso como célula vazia — equação decide (ant+D−C=0)
      "112;Conta zerada;38.663,35 D;2640.80;41304.15;38.663,35 C;",
      "2;PASSIVO;838.663,35 C;41304.15;662640.80;621.336,65 C;1.460.000,00 C",
      "21;Fornecedores;538.663,35 C;41304.15;362640.80;321.336,65 C;860.000,00 C",
      "22;Capital;300.000,00 C;0.00;300000.00;300.000,00 C;600.000,00 C",
      "3;RECEITAS;500,00 C;0.00;39500.00;39.500,00 C;40.000,00 C",
      "31;Vendas;500,00 C;0.00;39500.00;39.500,00 C;40.000,00 C",
    ].join("\n");
    const p = parseBalanceteTabular(buf(csv), "b.csv", "2022");
    expect(p.linhas.map((l) => l.nivel).slice(0, 4)).toEqual([1, 2, 3, 3]); // corrida: comprimentos → níveis
    const zerada = p.linhas.find((l) => l.nome === "Conta zerada")!;
    expect(zerada.saldoAtual).toBe(0); // NÃO herdou a coluna de movimento
    const c = converterBalancete(p);
    expect(c.provas.linhas.ok).toBe(true);
  });

  it("INDENTAÇÃO POR COLUNA (CADMO): dados fora dos índices do cabeçalho — a equação escolhe a leitura", () => {
    const csv = [
      "Código;;;Classificação;;;;Descrição da conta;;;;;;;Saldo Anterior;;;;;;;Débito;;;;Crédito;;;;;;Saldo Atual",
      // raiz: nome no índice do cabeçalho, mas Saldo Anterior 4 colunas à direita
      "1;;;1;;;;ATIVO;;;;;;;;;;;900.00;;;700.00;;;;100.00;;;;;;1500.00",
      "2;;;1.1;;;;;CIRCULANTE;;;;;;;;;;900.00;;;700.00;;;;100.00;;;;;;1500.00",
      "3;;;1.1.1;;;;;;Caixa;;;;;;;;;900.00;;;700.00;;;;100.00;;;;;;1500.00",
      "4;;;2;;;;PASSIVO;;;;;;;;;;;800.00;;;50.00;;;;450.00;;;;;;1200.00",
      "5;;;2.1;;;;;Fornecedores;;;;;;;;;;500.00;;;50.00;;;;450.00;;;;;;900.00",
      "6;;;2.2;;;;;Capital;;;;;;;;;;300.00;;;0.00;;;;0.00;;;;;;300.00",
      "7;;;3;;;;RECEITAS;;;;;;;;;;;500.00;;;0.00;;;;500.00;;;;;;1000.00",
      "8;;;3.1;;;;;Vendas;;;;;;;;;;500.00;;;0.00;;;;500.00;;;;;;1000.00",
      "9;;;4;;;;DESPESAS;;;;;;;;;;;400.00;;;300.00;;;;0.00;;;;;;700.00",
      "10;;;4.1;;;;;Aluguel;;;;;;;;;;400.00;;;300.00;;;;0.00;;;;;;700.00",
    ].join("\n");
    const p = parseBalanceteTabular(buf(csv), "b.csv", "2020");
    expect(p.linhas).toHaveLength(10);
    const ativo = p.linhas[0];
    expect(ativo.saldoAnterior).toBe(900); // achado pela varredura posicional
    const c = converterBalancete(p);
    expect(c.provas.fechamento.ok).toBe(true);
    expect(c.provas.linhas.ok).toBe(true);
  });
});
