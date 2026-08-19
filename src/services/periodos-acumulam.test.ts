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

  it("janeiro não acumula — YTD é o próprio mês", () => {
    expect(periodosQueAcumulam({ dre, balancetes: [{ periodo: "31/01/2026" }] })).toEqual([]);
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
