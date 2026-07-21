import { describe, it, expect } from "vitest";
import {
  curarConteudo,
  competenciaDoCabecalho,
  competenciaDosPeriodos,
  tipoPorKeywords,
} from "./curadoria-pool";

// Texto longo o bastante (>100 chars) com assinatura de balancete.
const BALANCETE_TXT =
  "Balancete de Verificação\nPeríodo: 01/2026 a 05/2026\n" +
  "Conta  Descrição  Saldo Anterior  Débito  Crédito  Saldo Atual\n" +
  Array.from({ length: 12 }, (_, i) => `1.1.${i}  CONTA ${i}  1.000,00  10,00  5,00  1.005,00`).join("\n");

const DRE_TXT =
  "DEMONSTRAÇÃO DO RESULTADO DO EXERCÍCIO\nReceita Bruta de Vendas\nDeduções da Receita\n" +
  "Custo das Mercadorias\nDespesas com Vendas\nResultado antes do IR\n" + "x".repeat(60);

const BP_TXT =
  "BALANÇO PATRIMONIAL\nATIVO\nAtivo Circulante  100.000,00\nCaixa  10.000,00\n" +
  "PASSIVO\nPassivo Circulante  40.000,00\nFornecedores  30.000,00\n" + "x".repeat(60);

describe("competenciaDoCabecalho", () => {
  it("período MM/YYYY a MM/YYYY → mês do fim", () => {
    expect(competenciaDoCabecalho("Período: 01/2026 a 05/2026", false)).toBe("2026-05");
  });
  it("período dd/mm/yyyy a dd/mm/yyyy → mês do fim", () => {
    expect(competenciaDoCabecalho("de 01/05/2026 a 31/05/2026", false)).toBe("2026-05");
  });
  it("jan..dez do MESMO ano com anualVira → ANO FECHADO", () => {
    expect(competenciaDoCabecalho("Período: 01/01/2024 a 31/12/2024", true)).toBe("2024");
  });
  it("jan..dez SEM anualVira (balancete é mensal) → dezembro", () => {
    expect(competenciaDoCabecalho("Período: 01/01/2024 a 31/12/2024", false)).toBe("2024-12");
  });
  it("sem período declarado → null", () => {
    expect(competenciaDoCabecalho("Relatório sem datas", true)).toBeNull();
  });
});

describe("competenciaDosPeriodos", () => {
  it("anos puros → ano fechado do MAIOR ano", () => {
    expect(competenciaDosPeriodos(["2023", "2024", "2025"])).toBe("2025");
  });
  it("fins de exercício (31/12/yyyy) contam como anuais", () => {
    expect(competenciaDosPeriodos(["31/12/2024", "31/12/2025"])).toBe("2025");
  });
  it("um único período mensal → aquele mês", () => {
    expect(competenciaDosPeriodos(["05/2026"])).toBe("2026-05");
  });
  it("mistura ambígua (vários meses) → nada — ausência de dado não vira afirmação", () => {
    expect(competenciaDosPeriodos(["03/2026", "04/2026"])).toBeNull();
  });
  it("períodos irreconhecíveis → null", () => {
    expect(competenciaDosPeriodos(["LTM", "proj."])).toBeNull();
  });
});

describe("tipoPorKeywords", () => {
  it("BP pelas assinaturas de ativo/passivo circulante", () => {
    expect(tipoPorKeywords(BP_TXT)).toBe("Balanço Patrimonial");
  });
  it("DRE pelas assinaturas de receita/deduções", () => {
    expect(tipoPorKeywords(DRE_TXT)).toBe("DRE");
  });
  it("documento composto (BP e DRE juntos) → não afirma um tipo só", () => {
    expect(tipoPorKeywords(BP_TXT + DRE_TXT)).toBeNull();
  });
});

describe("curarConteudo", () => {
  it("balancete: tipo pela assinatura estrutural + competência MENSAL do cabeçalho", () => {
    const c = curarConteudo(BALANCETE_TXT);
    expect(c.tipo).toBe("Balancete");
    expect(c.competencia).toBe("2026-05");
    expect(c.evidencias.length).toBeGreaterThan(0);
  });
  it("DRE tabular com períodos anuais → tipo DRE + ANO FECHADO", () => {
    const c = curarConteudo(DRE_TXT, ["2024", "2025"]);
    expect(c.tipo).toBe("DRE");
    expect(c.competencia).toBe("2025");
  });
  it("BP sem períodos nem cabeçalho de datas → tipo detectado, competência null", () => {
    const c = curarConteudo(BP_TXT);
    expect(c.tipo).toBe("Balanço Patrimonial");
    expect(c.competencia).toBeNull();
  });
  it("texto curto/escaneado → nada se afirma", () => {
    expect(curarConteudo("abc")).toEqual({ tipo: null, competencia: null, evidencias: [] });
  });
});
