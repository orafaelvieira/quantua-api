import { describe, it, expect } from "vitest";
import { parseBRNumber, yearFromFilename, detectPeriodsFromPDF } from "./parser";

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
