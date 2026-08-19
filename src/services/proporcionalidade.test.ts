import { describe, it, expect } from "vitest";
import { medirProporcionalidade } from "./proporcionalidade";

const dre = (v: Record<string, Record<string, number>>) =>
  Object.entries(v).map(([conta, valores]) => ({ conta, valores }));

// Série REAL da Belagro: 2024 e 2025 fechados + 2026 em balancete mensal.
const BELAGRO = dre({
  "Receita Líquida":     { "2024": 592_042_364, "31/12/2025": 741_125_792, "31/05/2026": 328_504_142 },
  "Custo Operacional":   { "2024": -547_420_000, "31/12/2025": -685_050_000, "31/05/2026": -306_710_000 },
  "EBITDA":              { "2024": 15_440_000, "31/12/2025": 13_800_000, "31/05/2026": -4_120_000 },
  "Despesas Financeiras":{ "2024": -3_650_000, "31/12/2025": -8_520_000, "31/05/2026": -7_250_000 },
  "Lucro Líquido":       { "2024": 11_581_723, "31/12/2025": 6_454_351, "31/05/2026": -3_918_151 },
});
const PER = ["2024", "31/12/2025", "31/05/2026"];
// 31/12/2025 e' acumulado E fechado — as duas listas se sobrepoem de proposito.
const YTD = ["31/05/2026", "31/12/2025"];
const FECH = ["2024", "31/12/2025"];

describe("medirProporcionalidade", () => {
  it("aponta a linha que desvia — e na Belagro NÃO é a receita", () => {
    const r = medirProporcionalidade(BELAGRO, PER, YTD, FECH)!;
    const por = Object.fromEntries(r.linhas.map((l) => [l.conta, l]));
    expect(por["Receita Líquida"].ritmo).toBeCloseTo(1.06, 2);
    expect(por["Custo Operacional"].ritmo).toBeCloseTo(1.07, 2);
    expect(por["EBITDA"].ritmo).toBeCloseTo(-0.72, 2);
    // a despesa financeira roda ao DOBRO do ritmo — o achado mais duro do teste
    expect(por["Despesas Financeiras"].ritmo).toBeCloseTo(2.04, 2);
  });

  it("a leitura publica os DOIS fatos por linha e recusa julgar", () => {
    const r = medirProporcionalidade(BELAGRO, PER, YTD, FECH)!;
    // quanto do calendário passou e quanto cada linha realizou — nada além disso
    expect(r.leitura).toContain("41,7% do calendário");
    expect(r.leitura).toContain("Receita Líquida 44,3% (1,06× do proporcional)");
    expect(r.leitura).toContain("NÃO distingue sazonalidade de deterioração");
    expect(r.leitura).toContain("não classifica desvio como grande ou pequeno");
  });

  // Sem limiar não há "dentro" nem "fora": a saída é a mesma em qualquer empresa,
  // muda só o número. É o que faz a régua servir para todos os segmentos sem que
  // ninguém precise declarar nada sobre o negócio.
  it("negócio uniforme e negócio sazonal produzem a MESMA forma de saída", () => {
    const uniforme = dre({ "Receita Líquida": { "31/12/2025": 1_200_000, "31/05/2026": 500_000 } });
    const r = medirProporcionalidade(uniforme, ["31/12/2025", "31/05/2026"], ["31/05/2026"], ["31/12/2025"])!;
    expect(r.leitura).toContain("41,7% do calendário");
    expect(r.leitura).toContain("não classifica desvio como grande ou pequeno");
    expect(r.linhas[0].ritmo).toBeCloseTo(1.0, 1); // 41,7% de 1,2 mi ≈ 500 mil
  });

  it("compara contra o fechamento mais recente, não contra o mais antigo", () => {
    const r = medirProporcionalidade(BELAGRO, PER, YTD, FECH)!;
    expect(r.periodoFechado).toBe("31/12/2025");
    expect(r.meses).toBe(5);
    expect(r.fracaoCalendario).toBeCloseTo(5 / 12, 4);
  });

  it("negócio no ritmo não trava nada", () => {
    const d = dre({
      "Receita Líquida": { "31/12/2025": 1200, "31/05/2026": 500_000 },
      "EBITDA": { "31/12/2025": 120_000, "31/05/2026": 50_000 },
    });
    d[0].valores["31/12/2025"] = 1_200_000;
    const r = medirProporcionalidade(d, ["31/12/2025", "31/05/2026"], ["31/05/2026"], ["31/12/2025"])!;
    expect(r.leitura).toContain("41,7% do calendário");
  });

  it("sem exercício fechado anterior não há medida", () => {
    expect(medirProporcionalidade(BELAGRO, ["31/05/2026"], YTD, [])).toBeNull();
  });

  it("série que já chegou em dezembro não é janela parcial", () => {
    const d = dre({ "Receita Líquida": { "31/12/2025": 741_125_792, "31/12/2026": 800_000_000 } });
    expect(medirProporcionalidade(d, ["31/12/2025", "31/12/2026"], ["31/12/2026"], ["31/12/2025"])).toBeNull();
  });

  it("linha com base perto de zero no fechamento é ignorada (não vira razão absurda)", () => {
    const d = dre({
      "Receita Líquida": { "31/12/2025": 741_125_792, "31/05/2026": 328_504_142 },
      "EBITDA": { "31/12/2025": 12, "31/05/2026": -4_120_000 },
    });
    const r = medirProporcionalidade(d, PER, YTD, FECH)!;
    expect(r.linhas.map((l) => l.conta)).toEqual(["Receita Líquida"]);
  });
});

// ── Achados da revisão adversarial (todos BLOQUEIA_DEPLOY ou ALTA) ──
describe("medirProporcionalidade · bordas que a revisão encontrou", () => {
  it("coluna de DRE RECUSADA (subtotais zerados) não vira janela — devolve null", () => {
    const d = dre({
      "Receita Líquida": { "31/12/2025": 741_125_792, "31/05/2026": 0 },
      "EBITDA": { "31/12/2025": 13_800_000, "31/05/2026": 0 },
    });
    // sem a guarda saía "Receita Líquida a 0,00× do proporcional" e amordaçava a DRE inteira
    expect(medirProporcionalidade(d, ["31/12/2025", "31/05/2026"], ["31/05/2026"], ["31/12/2025"])).toBeNull();
  });

  it("balancete de DEZEMBRO encerrado (janela de 1 mês) não serve de exercício fechado", () => {
    const d = dre({ "Receita Líquida": { "31/12/2025": 62_000_000, "31/05/2026": 300_000_000 } });
        // janela de 01/12 a 31/12 nao cobre o exercicio -> fora da lista de fechados
    expect(medirProporcionalidade(d, ["31/12/2025", "31/05/2026"], ["31/05/2026"], [])).toBeNull();
  });

  it("com o documento ANUAL e o balancete de dezembro juntos, o ano vence", () => {
    const d = dre({ "Receita Líquida": { "2025": 741_125_792, "31/12/2025": 62_000_000, "31/05/2026": 328_504_142 } });
    // periodosDeExercicioFechado elege só "2025": o balancete de 31/12 tem janela
    // de 01/12 e não cobre o exercício.
    const r = medirProporcionalidade(d, ["2025", "31/12/2025", "31/05/2026"], ["31/05/2026"], ["2025"])!;
    expect(r.periodoFechado).toBe("2025");
    expect(r.linhas[0].ritmo).toBeCloseTo(1.06, 2); // e não 11,61x
  });

  it("balancete de encerramento que cobre o exercício (01/01) É aceito", () => {
    const d = dre({ "Receita Líquida": { "31/12/2025": 741_125_792, "31/05/2026": 328_504_142 } });
    expect(medirProporcionalidade(d, ["31/12/2025", "31/05/2026"], ["31/05/2026"], ["31/12/2025"])!.periodoFechado).toBe("31/12/2025");
  });

  // Corte silencioso por idade foi REMOVIDO: recusar em silêncio já custou a régua
  // inteira uma vez hoje. A referência vai nomeada e se avisa sozinha.
  it("fechamento antigo NÃO é recusado — é nomeado, e o leitor julga", () => {
    const d = dre({ "Receita Líquida": { "2019": 100_000_000, "31/05/2026": 328_504_142 } });
    const r = medirProporcionalidade(d, ["2019", "31/05/2026"], ["31/05/2026"], ["2019"])!;
    expect(r.periodoFechado).toBe("2019");
    expect(r.leitura).toContain("exercício fechado de 2019");
  });

  it("o rótulo do fechamento é o EXERCÍCIO, nunca um mês", () => {
    const r = medirProporcionalidade(BELAGRO, PER, YTD, FECH)!;
    expect(r.leitura).toContain("exercício fechado de 2025");
    expect(r.leitura).not.toContain("12/2025");
  });
});
