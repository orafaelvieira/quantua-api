import { describe, it, expect } from "vitest";
import { parseBRNumber, yearFromFilename, detectPeriodsFromPDF, collapseOpeningClosing, juntarNomeValorQuebrados } from "./parser";

describe("parseBRNumber — sinal contábil (parênteses = negativo)", () => {
  it("positivo simples", () => {
    expect(parseBRNumber("1.234,56")).toBe(1234.56);
    expect(parseBRNumber("5.466.398,52")).toBe(5466398.52);
  });

  it("negativo entre parênteses (sem espaço)", () => {
    expect(parseBRNumber("(1.234,56)")).toBe(-1234.56);
  });

  // Regressão do bug do PL negativo da Maniacs: balancete escreve "(N )" com espaço
  // antes do parêntese de fechamento — era lido como POSITIVO, inflando Passivo+PL.
  it("negativo com espaço antes do parêntese: (N )", () => {
    expect(parseBRNumber("(6.339.251,77 )")).toBe(-6339251.77);
    expect(parseBRNumber("(497.714,00 )")).toBe(-497714);
  });

  it("negativo com captura imperfeita de um só parêntese", () => {
    expect(parseBRNumber("(6.339.251,77")).toBe(-6339251.77); // só abertura
    expect(parseBRNumber("6.339.251,77 )")).toBe(-6339251.77); // só fechamento
  });

  it("vazio/inválido → null", () => {
    expect(parseBRNumber("")).toBeNull();
    expect(parseBRNumber("   ")).toBeNull();
  });
});

describe("yearFromFilename — ano do nome do arquivo", () => {
  it("extrai ano único", () => {
    expect(yearFromFilename("B&You_DRE_2018.pdf")).toBe("2018");
    expect(yearFromFilename("Wolk_2019_Demonstração do Resultado.pdf")).toBe("2019");
    expect(yearFromFilename("16. OHNE - Balanço Patrimonial e DRE 06.2018.pdf")).toBe("2018");
    expect(yearFromFilename("2024-Balanco_2024_Edunext.pdf")).toBe("2024"); // repetido = 1 distinto
  });
  it("ambíguo ou ausente → null", () => {
    expect(yearFromFilename("relatorio_2022_vs_2023.pdf")).toBeNull(); // 2 distintos
    expect(yearFromFilename("balancete.pdf")).toBeNull();
    expect(yearFromFilename(undefined)).toBeNull();
  });
});

describe("detectPeriodsFromPDF — filename como dica no fallback", () => {
  it("texto sem data declarada → usa o ano do nome", () => {
    expect(detectPeriodsFromPDF("DRE\nReceita 1.000,00\nLucro 100,00", "X_DRE_2018.pdf")).toEqual(["2018"]);
  });
  // Regressão dos casos B&You/Wolk: ano espúrio no texto perdia pro nome do arquivo.
  it("ano espúrio no texto perde pro nome do arquivo", () => {
    expect(detectPeriodsFromPDF("Conforme Lei 2020 ... Receita 1.000,00", "X_DRE_2019.pdf")).toEqual(["2019"]);
  });
  it("NÃO sobrepõe data autoritativa do documento (Encerrado em)", () => {
    expect(detectPeriodsFromPDF("Encerrado em 31/12/2017\nReceita 1.000,00", "X_2019.pdf")).toEqual(["31/12/2017"]);
  });
  it("sem filename: anos 2016-2019 voltam a ser detectados (faixa alargada)", () => {
    expect(detectPeriodsFromPDF("Exercício de 2018\nReceita 1.000,00")).toEqual(["2018"]);
  });
});

describe("collapseOpeningClosing — saldo abertura+fechamento (ECF/ECD/SPED)", () => {
  const row = (valores: Record<string, number>) => ({ conta: "X", valores } as any);

  it("BP: valor nas 2 colunas → mantém o FECHAMENTO (31/12)", () => {
    const linhas = [row({ "01/01/2022": 50400, "31/12/2022": 1865611 })];
    expect(collapseOpeningClosing(["01/01/2022", "31/12/2022"], linhas)).toEqual(["31/12/2022"]);
    expect(linhas[0].valores).toEqual({ "31/12/2022": 1865611 });
  });

  it("DRE: resultado só na abertura → MOVE pro fechamento", () => {
    const linhas = [row({ "01/01/2022": -29555 })];
    expect(collapseOpeningClosing(["01/01/2022", "31/12/2022"], linhas)).toEqual(["31/12/2022"]);
    expect(linhas[0].valores).toEqual({ "31/12/2022": -29555 });
  });

  it("período parcial (SPED 1º sem): 01/01 a 30/06 → 30/06", () => {
    const linhas = [row({ "01/01/2020": 10, "30/06/2020": 1781625 })];
    expect(collapseOpeningClosing(["01/01/2020", "30/06/2020"], linhas)).toEqual(["30/06/2020"]);
    expect(linhas[0].valores).toEqual({ "30/06/2020": 1781625 });
  });

  it("NÃO colapsa comparativo de anos diferentes (31/12/2021 vs 31/12/2022)", () => {
    const linhas = [row({ "31/12/2021": 100, "31/12/2022": 200 })];
    expect(collapseOpeningClosing(["31/12/2021", "31/12/2022"], linhas)).toEqual(["31/12/2021", "31/12/2022"]);
    expect(linhas[0].valores).toEqual({ "31/12/2021": 100, "31/12/2022": 200 });
  });

  it("NÃO colapsa quando a menor data não é início de período (30/06 vs 31/12)", () => {
    expect(collapseOpeningClosing(["30/06/2022", "31/12/2022"], [row({})])).toEqual(["30/06/2022", "31/12/2022"]);
  });

  it("período único: inalterado", () => {
    expect(collapseOpeningClosing(["31/12/2022"], [row({ "31/12/2022": 1 })])).toEqual(["31/12/2022"]);
  });
});

// Regressão do caso AOCP (visualizador SPED): algumas linhas renderizam nome e valores
// em baselines vizinhas (linhas separadas) e nomes longos quebram em 2 linhas com os
// valores no MEIO — sem a junção, o PL inteiro e as contas do PNC sumiam da extração.
describe("juntarNomeValorQuebrados — pares nome/valor do visualizador SPED", () => {
  it("nome órfão + linha de valores → uma linha só", () => {
    const raw = [
      "     PATRIMÔNIO LÍQUIDO",
      "                     R$ 2.800.000,00                  R$ 3.400.000,00",
      "      CAPITAL SOCIAL",
      "                     R$ 2.800.000,00                  R$ 3.400.000,00",
    ].join("\n");
    const out = juntarNomeValorQuebrados(raw).split("\n");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^     PATRIMÔNIO LÍQUIDO\s+R\$ 2\.800\.000,00/);
    expect(out[1]).toMatch(/^      CAPITAL SOCIAL\s+R\$ 2\.800\.000,00/);
  });

  it("nome quebrado em 2 linhas com valores no meio → junta os fragmentos", () => {
    const raw = [
      "       (-) (-) ENCARGOS S/ EMPRÉSTIMOS E ",
      "                     R$ (78.391,93)                   R$ (333.421,03)",
      "    FINANCIAMENTOS",
      "       PARCELAMENTOS                                  R$ 2.831.703,57                  R$ 1.964.719,78",
    ].join("\n");
    const out = juntarNomeValorQuebrados(raw).split("\n");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("ENCARGOS S/ EMPRÉSTIMOS E FINANCIAMENTOS");
    expect(out[0]).toContain("R$ (333.421,03)");
    expect(out[1]).toContain("PARCELAMENTOS");
  });

  it("linha seguinte que espera o próprio par NÃO é tratada como continuação", () => {
    const raw = [
      "       OUTRAS OBRIGAÇÕES A PAGAR",
      "                     R$ 317.511,06                   R$ 105.363,38",
      "       LUCROS OU DIVIDENDOS APURADOS",
      "                     R$ 0,00                   R$ 509.619,94",
    ].join("\n");
    const out = juntarNomeValorQuebrados(raw).split("\n");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("OUTRAS OBRIGAÇÕES A PAGAR");
    expect(out[0]).toContain("105.363,38");
    expect(out[1]).toContain("LUCROS OU DIVIDENDOS APURADOS");
    expect(out[1]).toContain("509.619,94");
  });

  it("linhas inline e cabeçalhos passam intactos", () => {
    const raw = [
      "                 Descrição                     Nota                Saldo Inicial                   Saldo Final",
      "    ATIVO                                      R$ 6.593.019,93                  R$ 8.147.304,62",
    ].join("\n");
    expect(juntarNomeValorQuebrados(raw)).toBe(raw);
  });
});
