import { describe, it, expect } from "vitest";
import { periodosQueAcumulam } from "./balancete-conversao";

// A lista que o Fluxo de Caixa consome NÃO é "os períodos de balancete".
// Três colunas de balancete podem não acumular, e subtrair nelas inventa número.
const dre = [{ conta: "Lucro Líquido", valores: {
  "31/01/2026": 1_156_428, "30/11/2025": 9_669_025, "31/12/2025": 6_454_351, "31/05/2026": -3_918_151,
} }];

describe("periodosQueAcumulam", () => {
  it("exercício ENCERRADO não acumula — a apuração zera o resultado e o valor vira MOVIMENTO", () => {
    const r = periodosQueAcumulam({ dre, balancetes: [
      { periodo: "30/11/2025", provas: { exercicioEncerrado: false } },
      { periodo: "31/12/2025", provas: { exercicioEncerrado: true } },
    ] });
    expect(r).toContain("30/11/2025");
    expect(r).not.toContain("31/12/2025"); // subtrair aqui daria −R$ 3,2 mi de prejuízo inventado
  });

  // REGRA INVERTIDA em 18/08 e o motivo importa: janeiro ACUMULA (YTD jan = jan).
  // Excluí-lo não desligava a subtração de janeiro — desligava a de FEVEREIRO, que
  // perdia o par e usava o YTD de 2 meses como resultado do mês. O plug de
  // fevereiro saía −R$ 1.263.579 onde o certo é −R$ 107.151, e o excesso era, ao
  // centavo, o lucro YTD de janeiro. Consertar dezembro e excluir janeiro apenas
  // mudou o defeito de mês. A virada de exercício é barrada pela guarda de mesmo
  // ano no consumidor, não por esta lista.
  it("janeiro ENTRA — é acumulado, e sem ele fevereiro herda o fantasma", () => {
    expect(periodosQueAcumulam({ dre, balancetes: [{ periodo: "31/01/2026" }] })).toEqual(["31/01/2026"]);
  });

  it("coluna sem DRE publicada fica de fora — 0 menos o YTD anterior viraria o ano inteiro", () => {
    const semDRE = [{ conta: "Lucro Líquido", valores: { "30/11/2025": 9_669_025 } }];
    const r = periodosQueAcumulam({ dre: semDRE, balancetes: [
      { periodo: "30/11/2025" }, { periodo: "31/12/2025" }, // 31/12 reprovada no P4: sem valor
    ] });
    expect(r).toEqual(["30/11/2025"]);
  });

  it("mês comum de balancete acumula", () => {
    expect(periodosQueAcumulam({ dre, arvoresBalancete: [{ periodo: "31/05/2026" }] })).toEqual(["31/05/2026"]);
  });

  it("período anual não é balancete e não entra", () => {
    expect(periodosQueAcumulam({ dre, balancetes: [{ periodo: "2024" }] })).toEqual([]);
  });
});

// Achado da revisão adversarial: `0` é number e derrotava a guarda de "DRE não
// publicada" — a coluna recusada entrava como acumulada e o FC subtraía 0 menos
// o YTD anterior, fabricando prejuízo do tamanho do ano. Bug que chegou a produção.
describe("periodosQueAcumulam · DRE recusada grava ZERO nos subtotais", () => {
  it("coluna com subtotais zerados não conta como DRE publicada", () => {
    const dre = [{ conta: "Lucro Líquido", valores: { "30/11/2025": 9_669_025, "31/12/2025": 0 } }];
    expect(periodosQueAcumulam({ dre, balancetes: [{ periodo: "30/11/2025" }, { periodo: "31/12/2025" }] }))
      .toEqual(["30/11/2025"]);
  });

  it("valor material negativo continua valendo — prejuízo é resultado, não ausência", () => {
    const dre = [{ conta: "Lucro Líquido", valores: { "30/11/2025": 9_669_025, "31/12/2025": -3_214_674 } }];
    expect(periodosQueAcumulam({ dre, balancetes: [{ periodo: "30/11/2025" }, { periodo: "31/12/2025" }] }))
      .toEqual(["30/11/2025", "31/12/2025"]);
  });
});

// ── periodosDeExercicioFechado: a OUTRA pergunta ──
// 31/12 é acumulado E fechado ao mesmo tempo. Inferir "fechado" pela ausência na
// lista de acumulados derrubava a comparação para o exercício anterior: na
// Belagro, contra 2024 em vez de 2025 — receita e custo acusados de fora do ritmo
// quando estavam no ritmo, e a base da alavanca caindo de 741,1 para 592,0 mi.
import { periodosDeExercicioFechado } from "./balancete-conversao";

describe("periodosDeExercicioFechado", () => {
  const per = ["2024", "30/11/2025", "31/12/2025", "31/05/2026"];

  it("31/12 vindo de DEMONSTRATIVO (não balancete) fecha o exercício", () => {
    expect(periodosDeExercicioFechado({ periodos: per })).toEqual(["2024", "31/12/2025"]);
  });

  it("31/12 de BALANCETE fecha SALVO prova em contrário na janela declarada", () => {
    const jan = [{ periodo: "31/12/2025", periodoInicio: "01/01/2025" }];
    const dez = [{ periodo: "31/12/2025", periodoInicio: "01/12/2025" }];
    expect(periodosDeExercicioFechado({ periodos: per, balancetes: jan })).toContain("31/12/2025");
    expect(periodosDeExercicioFechado({ periodos: per, balancetes: dez })).not.toContain("31/12/2025");
  });

  // Exigir a prova POSITIVA custou a referência anual inteira em produção: as
  // árvores de balancete não carregam periodoInicio, e o IBR saiu dizendo "não há
  // exercício fechado na série" para uma empresa com dois exercícios na base.
  it("sem janela declarada, 31/12 vale como exercício — recusar custa mais que aceitar", () => {
    const semInicio = [{ periodo: "31/12/2025" }];
    expect(periodosDeExercicioFechado({ periodos: per, arvoresBalancete: semInicio })).toContain("31/12/2025");
  });

  it("série toda em balancete, sem metadado, ainda encontra os fechamentos", () => {
    const p2 = ["31/12/2024", "30/11/2025", "31/12/2025", "31/05/2026"];
    const bals = p2.map((periodo) => ({ periodo }));
    expect(periodosDeExercicioFechado({ periodos: p2, arvoresBalancete: bals }))
      .toEqual(["31/12/2024", "31/12/2025"]);
  });

  it("mês parcial nunca fecha exercício — nem janeiro, nem novembro, nem maio", () => {
    const r = periodosDeExercicioFechado({ periodos: ["31/01/2026", "30/11/2025", "31/05/2026"] });
    expect(r).toEqual([]);
  });

  it("as duas listas SE SOBREPÕEM em 31/12 — de propósito", () => {
    const dre = [{ conta: "Lucro Líquido", valores: { "30/11/2025": 9_669_025, "31/12/2025": 6_454_351 } }];
    const bals = [{ periodo: "30/11/2025" }, { periodo: "31/12/2025" }];
    expect(periodosQueAcumulam({ dre, balancetes: bals })).toContain("31/12/2025");
    expect(periodosDeExercicioFechado({ periodos: ["31/12/2025"] })).toContain("31/12/2025");
  });
});

// JANEIRO agora acumula — excluí-lo movia o defeito para fevereiro.
describe("periodosQueAcumulam · janeiro", () => {
  it("janeiro entra na lista (YTD jan = jan, e sem ele fevereiro quebra)", () => {
    const dre = [{ conta: "Lucro Líquido", valores: { "31/01/2026": 1_156_428, "28/02/2026": 1_573_345 } }];
    const bals = [{ periodo: "31/01/2026" }, { periodo: "28/02/2026" }];
    expect(periodosQueAcumulam({ dre, balancetes: bals })).toEqual(["31/01/2026", "28/02/2026"]);
  });
});
