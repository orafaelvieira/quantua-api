import { describe, it, expect } from "vitest";
import { parseBRNumber } from "./parser";

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
