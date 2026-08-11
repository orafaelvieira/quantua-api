/**
 * DEMONSTRATIVO EM PLANILHA — as formas reais do acervo.
 *
 * Antes deste leitor, balanço e DRE em xlsx/csv eram o formato SEM REDE: 6 de
 * 10 arquivos do corpus rendiam ZERO linha, "Nota" virava nome de período e o
 * Ativo Total saía {"Nota": 47473}. Cada teste aqui é uma forma que existe no
 * acervo real — se um deles cair, um formato inteiro volta a ser ilegível.
 */
import { describe, it, expect } from "vitest";
import { parseDemonstrativoMatriz, periodoDaCelula, valorDaCelula, periodoDoPreambulo } from "./demonstrativo-tabular";

/** Forma NOTAS EXPLICATIVAS (Centauro): hierarquia pela POSIÇÃO DA COLUNA e
 *  cabeçalho com data en-US ("12/31/23" = 31/12/2023). */
const NOTAS: string[][] = [
  ["Centauro Vida e Previdência S.A."],
  ["Balanços patrimoniais em 31 de dezembro"],
  ["(em milhares de R$)"],
  [],
  ["Ativo", "", "", "", "Nota", "12/31/23", "12/31/22"],
  [],
  ["", "Ativo circulante", "", "", "", "30929", "23402"],
  ["", "", "Disponível", "", "0", "735", "762"],
  ["", "", "", "Caixa e bancos", "", "735", "762"],
  ["", "", "Aplicações", "", "6 e 18", "19349", "16437"],
  ["Passivo", "", "", "", "Nota", "12/31/23", "12/31/22"],
  ["", "Passivo circulante", "", "", "", "28100", "25849"],
  ["", "", "Obrigações a pagar", "", "", "634", "631"],
];

/** Forma SISTEMA CONTÁBIL (Tango): sem cabeçalho de colunas, período no
 *  preâmbulo e BALANÇO DE DUAS COLUNAS — ativo à esquerda, passivo à direita
 *  na MESMA linha. Ler só um lado perdia metade do balanço. */
const DUAS_COLUNAS: string[][] = [
  ["13/01/2023 14:47 Pág:0001", "1438  TANGO TECH SERVICOS"],
  ["CNPJ: 06.229.282/0001-00"],
  ["Período: 31/12/2022"],
  ["BALANÇO PATRIMONIAL"],
  ["", " A T I V O", "2.755.312,57", "", " P A S S I V O", "2.755.312,57"],
  ["", "    ATIVO CIRCULANTE", "216.996,09", "", "    PASSIVO CIRCULANTE", "362.592,11"],
  ["", "       DISPONIBILIDADES", "59.976,12", "", "       IMPOSTOS A RECOLHER", "19.313,78"],
  ["", "          CAIXA GERAL", "270,71", "", "          ISS A PAGAR", "5.731,17"],
  ["", "       CLIENTES", "156.805,29", "", "    PATRIMONIO LIQUIDO", "2.392.720,46"],
  ["", "    ATIVO NAO CIRCULANTE", "2.538.316,48", "", "       CAPITAL SOCIAL", "2.392.720,46"],
];

const contasComValor = (r: ReturnType<typeof parseDemonstrativoMatriz>) =>
  (r?.linhas ?? []).filter((l) => Object.values(l.valores).some((v) => v !== 0));

describe("forma NOTAS EXPLICATIVAS (hierarquia por coluna)", () => {
  const r = parseDemonstrativoMatriz(NOTAS);

  it("reconhece as duas colunas de período, e não a coluna 'Nota'", () => {
    expect(r?.periodos).toEqual(["31/12/2023", "31/12/2022"]);
  });

  it("lê o valor de cada período na conta certa", () => {
    const caixa = contasComValor(r).find((l) => /caixa e bancos/i.test(l.conta));
    expect(caixa?.valores["31/12/2023"]).toBe(735);
    expect(caixa?.valores["31/12/2022"]).toBe(762);
  });

  it("a profundidade cresce com a coluna (o fold precisa disso p/ montar a árvore)", () => {
    const linhas = contasComValor(r);
    const circulante = linhas.find((l) => /ativo circulante/i.test(l.conta))!;
    const disponivel = linhas.find((l) => /disponível/i.test(l.conta))!;
    const caixa = linhas.find((l) => /caixa e bancos/i.test(l.conta))!;
    expect(disponivel.indent!).toBeGreaterThan(circulante.indent!);
    expect(caixa.indent!).toBeGreaterThan(disponivel.indent!);
  });

  it("o lado do PASSIVO não some", () => {
    expect(contasComValor(r).some((l) => /obrigações a pagar/i.test(l.conta))).toBe(true);
  });
});

describe("forma SISTEMA CONTÁBIL (duas colunas lado a lado)", () => {
  const r = parseDemonstrativoMatriz(DUAS_COLUNAS);

  it("pega o período do preâmbulo quando não há cabeçalho de colunas", () => {
    expect(r?.periodos).toEqual(["31/12/2022"]);
  });

  it("lê os DOIS lados da mesma linha (ativo e passivo)", () => {
    const linhas = contasComValor(r);
    expect(linhas.find((l) => /A T I V O/.test(l.conta))?.valores["31/12/2022"]).toBe(2755312.57);
    expect(linhas.find((l) => /P A S S I V O/.test(l.conta))?.valores["31/12/2022"]).toBe(2755312.57);
    expect(linhas.find((l) => /PASSIVO CIRCULANTE/.test(l.conta))?.valores["31/12/2022"]).toBe(362592.11);
  });

  it("o passivo fica mais à direita — os dois lados não se misturam na árvore", () => {
    const linhas = contasComValor(r);
    const ativo = linhas.find((l) => /ATIVO CIRCULANTE/.test(l.conta))!;
    const passivo = linhas.find((l) => /PASSIVO CIRCULANTE/.test(l.conta))!;
    expect(passivo.indent!).toBeGreaterThan(ativo.indent!);
  });
});

describe("período da célula", () => {
  it.each([
    ["31/12/2022", "31/12/2022"],
    ["12/31/23", "31/12/2023"],   // Excel en-US: quem manda é o componente > 12
    ["dez./2023", "31/12/2023"],
    ["2024", "31/12/2024"],
  ])("%s → %s", (entrada, esperado) => expect(periodoDaCelula(entrada)).toBe(esperado));

  it.each(["Nota", "1439  TANGO TECH CONSULTORIA", "45291", "30929"])(
    "NÃO confunde %s com período",
    // número solto nunca vira data: era o que fazia VALOR virar coluna de período
    (t) => expect(periodoDaCelula(t)).toBeNull(),
  );
});

describe("valor da célula", () => {
  it.each([
    ["216.996,09", 216996.09],
    ["2.755.312,57", 2755312.57],
    ["(1.234,56)", -1234.56],
    ["30929", 30929],
  ])("%s → %s", (entrada, esperado) => expect(valorDaCelula(entrada)).toBe(esperado));

  it.each(["-", "", "Nota", "6 e 18"])("%s não é valor", (t) => expect(valorDaCelula(t)).toBeNull());
});

describe("período do preâmbulo", () => {
  it("lê 'Período: 31/12/2022'", () => expect(periodoDoPreambulo(DUAS_COLUNAS)).toBe("31/12/2022"));
  it("lê data por extenso", () => {
    expect(periodoDoPreambulo([["Balanço patrimonial"], ["31 de dezembro de 2023"]])).toBe("31/12/2023");
  });
});

describe("recusa honesta", () => {
  it("planilha sem período nem colunas de valor devolve null (não inventa)", () => {
    expect(parseDemonstrativoMatriz([["Relatório"], ["sem números aqui"], ["nem período"]])).toBeNull();
  });
});
