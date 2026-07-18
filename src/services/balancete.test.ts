/**
 * Testes da linha de extração de BALANCETE (F1) — fixtures SINTÉTICAS que
 * reproduzem a matriz de formatos do corpus real de 7 sistemas contábeis
 * (PDFs de clientes NÃO são commitados — LGPD). Validação contra os PDFs
 * reais roda localmente via scripts/valida-balancetes.ts.
 */
import { describe, it, expect } from "vitest";
import { parseBalanceteTexto } from "./balancete-parser";
import { converterBalancete } from "./balancete-conversao";
import { mapAccountToBPGroup } from "./account-mapper";

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
