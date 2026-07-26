import { describe, it, expect } from "vitest";
import {
  calcularOrcadoRealizado,
  congelarOrcamento,
  janelaAnteriorDe,
  mesesDaJanela,
  ehLinhaPercentual,
  ehLinhaDeCusto,
  SnapshotOrcamento,
} from "./model-orcamento";
import { LinhaDre, Serie } from "./model-engine";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Série constante nos meses dados. */
function serie(meses: string[], valor: number): Serie {
  return Object.fromEntries(meses.map((m) => [m, valor]));
}

const MESES_2025 = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`);
const MESES_2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
const TODOS = [...MESES_2025, ...MESES_2026];

function linha(id: string, nome: string, grupo: LinhaDre["grupo"], valor: number, pct = 0): LinhaDre {
  return {
    id,
    nome,
    grupo,
    valores: serie(TODOS, valor),
    pctReceita: pct ? serie(TODOS, pct) : {},
  };
}

function snapshotBase(dre: LinhaDre[]): SnapshotOrcamento {
  return {
    id: "snap-1",
    nome: "Orçamento 2026",
    criadoEm: "2026-01-05T00:00:00.000Z",
    cenario: "Base",
    mesInicial: "2025-01",
    horizonteMeses: 24,
    dre,
  };
}

/** Todos os meses fechados, salvo os listados como projetados. */
function status(projetados: string[] = []): Record<string, "real" | "proj"> {
  return Object.fromEntries(TODOS.map((m) => [m, projetados.includes(m) ? "proj" : "real"])) as Record<
    string,
    "real" | "proj"
  >;
}

// ── Janelas ────────────────────────────────────────────────────────────────

describe("janelas", () => {
  it("lista meses de forma inclusiva", () => {
    expect(mesesDaJanela({ de: "2026-01", ate: "2026-04" })).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
  });

  it("janela de um mês só devolve esse mês", () => {
    expect(mesesDaJanela({ de: "2026-04", ate: "2026-04" })).toEqual(["2026-04"]);
  });

  it("janela invertida devolve vazio (não estoura)", () => {
    expect(mesesDaJanela({ de: "2026-06", ate: "2026-01" })).toEqual([]);
  });

  it("janela anterior desloca exatamente 12 meses, cruzando o ano", () => {
    // Equivale ao EOMONTH(I7,-13)+1 da planilha.
    expect(janelaAnteriorDe({ de: "2026-04", ate: "2026-04" })).toEqual({ de: "2025-04", ate: "2025-04" });
    expect(janelaAnteriorDe({ de: "2026-01", ate: "2026-03" })).toEqual({ de: "2025-01", ate: "2025-03" });
  });
});

describe("ehLinhaPercentual", () => {
  it("reconhece margens", () => {
    expect(ehLinhaPercentual("Margem Bruta(%)")).toBe(true);
    expect(ehLinhaPercentual("Margem Ebitda (%)")).toBe(true);
    expect(ehLinhaPercentual("Margem Líquida")).toBe(true);
  });
  it("não confunde linha de valor", () => {
    expect(ehLinhaPercentual("(+) Receita Bruta")).toBe(false);
    expect(ehLinhaPercentual("(-) Custo mercadorias vendidas")).toBe(false);
  });
});

// ── Variação em linhas de valor ────────────────────────────────────────────

describe("orçado × realizado — linhas de valor", () => {
  it("soma a janela e calcula variação absoluta e relativa", () => {
    const orc = [linha("receita", "(+) Receita Bruta", "receita", 100)];
    const real = [linha("receita", "(+) Receita Bruta", "receita", 110)];

    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: real,
      statusMes: status(),
      janela: { de: "2026-01", ate: "2026-03" },
    });

    const l = r.linhas[0]!;
    expect(l.periodo.orcado).toBe(300); // 3 meses × 100
    expect(l.periodo.realizado).toBe(330);
    expect(l.periodo.varAbs).toBe(30);
    expect(l.periodo.varPct).toBeCloseTo(0.1, 10);
  });

  it("compara com a mesma janela 12 meses atrás", () => {
    const orc = [linha("receita", "(+) Receita Bruta", "receita", 100)];
    // Realizado maior em 2026 que em 2025.
    const real: LinhaDre[] = [
      {
        id: "receita",
        nome: "(+) Receita Bruta",
        grupo: "receita",
        valores: { ...serie(MESES_2025, 80), ...serie(MESES_2026, 120) },
        pctReceita: {},
      },
    ];

    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: real,
      statusMes: status(),
      janela: { de: "2026-01", ate: "2026-02" },
    });

    const l = r.linhas[0]!;
    expect(r.janelaAnterior).toEqual({ de: "2025-01", ate: "2025-02" });
    expect(l.periodo.realizado).toBe(240);
    expect(l.periodoAnterior.realizado).toBe(160);
    // Faixa 4: realizado atual × realizado de 12 meses atrás.
    expect(l.realizadoVsAnterior.varAbs).toBe(80);
    expect(l.realizadoVsAnterior.varPct).toBeCloseTo(0.5, 10);
    // Faixa 3: orçado é constante nos dois períodos.
    expect(l.orcadoVsAnterior.varAbs).toBe(0);
  });

  it("base zero devolve null, e não 0% (corrige o IFERROR da planilha)", () => {
    const orc = [linha("receita", "(+) Receita Bruta", "receita", 0)];
    const real = [linha("receita", "(+) Receita Bruta", "receita", 50)];

    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: real,
      statusMes: status(),
      janela: { de: "2026-01", ate: "2026-01" },
    });

    const l = r.linhas[0]!;
    expect(l.periodo.varAbs).toBe(50);
    expect(l.periodo.varPct).toBeNull();
    expect(l.semaforo).toBe("neutro");
  });
});

// ── Variação em linhas percentuais ─────────────────────────────────────────

describe("orçado × realizado — linhas percentuais", () => {
  it("não soma margens: recalcula a razão dos agregados e devolve pontos", () => {
    // Margem orçada 10% (10 sobre 100 de receita), realizada 20% (30 sobre 150).
    const orc: LinhaDre[] = [
      { id: "mb", nome: "Margem Bruta(%)", grupo: "subtotal", valores: serie(TODOS, 10), pctReceita: serie(TODOS, 0.1) },
    ];
    const real: LinhaDre[] = [
      { id: "mb", nome: "Margem Bruta(%)", grupo: "subtotal", valores: serie(TODOS, 30), pctReceita: serie(TODOS, 0.2) },
    ];

    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: real,
      statusMes: status(),
      janela: { de: "2026-01", ate: "2026-03" },
    });

    const l = r.linhas[0]!;
    expect(l.tipo).toBe("percentual");
    // Razão dos agregados: 30 ÷ 100 = 10% orçado; 90 ÷ 450 = 20% realizado.
    expect(l.periodo.orcado).toBeCloseTo(0.1, 10);
    expect(l.periodo.realizado).toBeCloseTo(0.2, 10);
    // Absoluto não se aplica (a planilha punha a string "n.d" aqui).
    expect(l.periodo.varAbs).toBeNull();
    // Diferença em PONTOS, não variação relativa.
    expect(l.periodo.varPct).toBeCloseTo(0.1, 10);
  });
});

// ── Semáforo ───────────────────────────────────────────────────────────────

describe("semáforo", () => {
  const janela = { de: "2026-01", ate: "2026-01" };

  /** O semáforo só acende contra valor OBSERVADO — daí o balancete no input. */
  function semaforoDe(grupo: LinhaDre["grupo"], orcado: number, realizado: number) {
    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase([linha("x", "Linha", grupo, orcado)]),
      dreRealizada: [linha("x", "Linha", grupo, realizado)],
      statusMes: status(),
      realizado: { meses: ["2026-01"], porLinha: { x: { "2026-01": realizado } } },
      janela,
    });
    return r.linhas[0]!.semaforo;
  }

  it("receita acima do orçado é favorável, por maior que seja", () => {
    expect(semaforoDe("receita", 100, 130)).toBe("verde");
  });

  it("receita muito abaixo do orçado acende vermelho", () => {
    expect(semaforoDe("receita", 100, 80)).toBe("vermelho");
  });

  it("custo acima do orçado acende alerta", () => {
    expect(semaforoDe("custos", 100, 107)).toBe("amarelo");
    expect(semaforoDe("custos", 100, 130)).toBe("vermelho");
  });

  it("custo abaixo do orçado é favorável", () => {
    expect(semaforoDe("custos", 100, 70)).toBe("verde");
  });

  it("dentro da tolerância é verde nos dois sentidos", () => {
    expect(semaforoDe("custos", 100, 103)).toBe("verde");
    expect(semaforoDe("receita", 100, 98)).toBe("verde");
  });

  // REGRESSÃO (achada com os dados reais da Belagro): o motor emite os
  // subtotais de custo com grupo "subtotal" (ex.: id "custos-total", nome
  // "(−) Custos"). Tratando-os como resultado, gastar MENOS que o orçado
  // aparecia VERMELHO — o oposto da leitura correta.
  describe("subtotal de custo não pode ser lido como resultado", () => {
    function semaforoDeLinha(id: string, nome: string, orcado: number, realizado: number) {
      const l = { id, nome, grupo: "subtotal" as const };
      const r = calcularOrcadoRealizado({
        snapshot: snapshotBase([{ ...l, valores: serie(TODOS, orcado), pctReceita: {} }]),
        dreRealizada: [{ ...l, valores: serie(TODOS, realizado), pctReceita: {} }],
        statusMes: status(),
        realizado: { meses: ["2026-01"], porLinha: { [id]: { "2026-01": realizado } } },
        janela: { de: "2026-01", ate: "2026-01" },
      });
      return r.linhas[0]!.semaforo;
    }

    it("custo abaixo do orçado é VERDE (era vermelho antes da correção)", () => {
      expect(semaforoDeLinha("custos-total", "(−) Custos", 100, 75)).toBe("verde");
      expect(semaforoDeLinha("despesas-total", "(−) Despesas", 100, 75)).toBe("verde");
    });

    it("custo acima do orçado é VERMELHO", () => {
      expect(semaforoDeLinha("custos-total", "(−) Custos", 100, 130)).toBe("vermelho");
    });

    it("subtotal de resultado continua lendo na direção do lucro", () => {
      expect(semaforoDeLinha("ebitda", "EBITDA", 100, 130)).toBe("verde");
      expect(semaforoDeLinha("lucro-bruto", "Lucro Bruto", 100, 70)).toBe("vermelho");
    });

    it("reconhece linha redutora pelo prefixo (−), mesmo com id desconhecido", () => {
      expect(semaforoDeLinha("linha-nova", "(−) Fretes", 100, 70)).toBe("verde");
      expect(semaforoDeLinha("linha-nova", "(−) Fretes", 100, 130)).toBe("vermelho");
    });
  });
});

describe("ehLinhaDeCusto", () => {
  it("classifica pelos três sinais: grupo, id conhecido e prefixo redutor", () => {
    expect(ehLinhaDeCusto("x", "Qualquer", "custos")).toBe(true);
    expect(ehLinhaDeCusto("x", "Qualquer", "despesas")).toBe(true);
    expect(ehLinhaDeCusto("custos-total", "(−) Custos", "subtotal")).toBe(true);
    expect(ehLinhaDeCusto("juros-divida", "Juros", "subtotal")).toBe(true);
    expect(ehLinhaDeCusto("nova", "(−) Alguma redução", "subtotal")).toBe(true);
    // Aceita o hífen comum além do sinal de menos tipográfico.
    expect(ehLinhaDeCusto("nova", "(-) Outra redução", "subtotal")).toBe(true);
  });

  it("não confunde receita nem resultado com custo", () => {
    expect(ehLinhaDeCusto("receita-total", "Receita", "subtotal")).toBe(false);
    expect(ehLinhaDeCusto("ebitda", "EBITDA", "subtotal")).toBe(false);
    expect(ehLinhaDeCusto("lucro-liquido", "Lucro líquido", "subtotal")).toBe(false);
    expect(ehLinhaDeCusto("linha", "Venda de sucata", "receita")).toBe(false);
  });
});

// ── Avisos (verde só com prova) ────────────────────────────────────────────

describe("avisos", () => {
  it("avisa quando a janela inclui meses ainda projetados", () => {
    const orc = [linha("receita", "(+) Receita Bruta", "receita", 100)];
    const real = [linha("receita", "(+) Receita Bruta", "receita", 100)];

    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: real,
      statusMes: status(["2026-03"]),
      janela: { de: "2026-01", ate: "2026-03" },
    });

    expect(r.mesesFechados).toEqual(["2026-01", "2026-02"]);
    expect(r.mesesProjetados).toEqual(["2026-03"]);
    expect(r.avisos.join(" ")).toMatch(/projetado/i);
  });

  it("avisa quando surge linha no realizado que não existia no orçamento congelado", () => {
    // Exatamente o modo de falha do Claude Log: conta nova entra no realizado
    // e some da comparação sem ninguém ver.
    const orc = [linha("receita", "(+) Receita Bruta", "receita", 100)];
    const real = [
      linha("receita", "(+) Receita Bruta", "receita", 100),
      linha("combustiveis", "Combustíveis", "custos", 363_155.78),
    ];

    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: real,
      statusMes: status(),
      janela: { de: "2026-01", ate: "2026-01" },
    });

    expect(r.avisos.join(" ")).toMatch(/Combustíveis/);
  });

  it("avisa em período inválido em vez de devolver número silencioso", () => {
    const orc = [linha("receita", "(+) Receita Bruta", "receita", 100)];
    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: orc,
      statusMes: status(),
      janela: { de: "2026-06", ate: "2026-01" },
    });
    expect(r.avisos.join(" ")).toMatch(/inválido/i);
    expect(r.linhas[0]!.periodo.orcado).toBe(0);
  });
});

// ── Realizado observado (balancete) ────────────────────────────────────────

describe("lado realizado vem do balancete, não da projeção", () => {
  const janela = { de: "2026-01", ate: "2026-02" };

  /** Orçamento 100/mês; projeção do motor 100/mês; balancete observou 80/mês. */
  function cenario() {
    const orc = [linha("receita-total", "Receita", "subtotal", 100)];
    const projecao = [linha("receita-total", "Receita", "subtotal", 100)];
    return { orc, projecao };
  }

  it("usa o valor observado, e não a projeção, quando há balancete", () => {
    const { orc, projecao } = cenario();
    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: projecao,
      statusMes: status(),
      realizado: {
        meses: ["2026-01", "2026-02"],
        porGrupo: { receita: { "2026-01": 80, "2026-02": 80 } },
      },
      janela,
    });

    const l = r.linhas[0]!;
    expect(l.observado).toBe(true);
    expect(l.periodo.orcado).toBe(200);
    expect(l.periodo.realizado).toBe(160); // do balancete, não os 200 da projeção
    expect(l.periodo.varAbs).toBe(-40);
    expect(r.mesesFechados).toEqual(["2026-01", "2026-02"]);
  });

  it("linha sem observação fica marcada e com semáforo neutro", () => {
    const orc = [
      linha("receita-total", "Receita", "subtotal", 100),
      linha("outra-linha", "Linha sem acoplamento", "custos", 50),
    ];
    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: orc,
      statusMes: status(),
      realizado: { meses: ["2026-01", "2026-02"], porGrupo: { receita: { "2026-01": 80, "2026-02": 80 } } },
      janela,
    });

    expect(r.linhas.find((l) => l.id === "receita-total")!.observado).toBe(true);
    const semObs = r.linhas.find((l) => l.id === "outra-linha")!;
    expect(semObs.observado).toBe(false);
    // Não acende verde só porque orçado == projeção.
    expect(semObs.semaforo).toBe("neutro");
    expect(r.avisos.join(" ")).toMatch(/não têm valor observado/i);
  });

  it("deriva Lucro Bruto e EBITDA observados a partir dos grupos", () => {
    const orc = [
      linha("receita-total", "Receita", "subtotal", 100),
      linha("custos-total", "(−) Custos", "subtotal", 60),
      linha("despesas-total", "(−) Despesas", "subtotal", 20),
      linha("lucro-bruto", "Lucro Bruto", "subtotal", 40),
      linha("ebitda", "EBITDA", "subtotal", 20),
    ];
    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: orc,
      statusMes: status(),
      realizado: {
        meses: ["2026-01"],
        porGrupo: {
          receita: { "2026-01": 200 },
          custos: { "2026-01": 150 },
          despesas: { "2026-01": 30 },
        },
      },
      janela: { de: "2026-01", ate: "2026-01" },
    });

    const lb = r.linhas.find((l) => l.id === "lucro-bruto")!;
    const eb = r.linhas.find((l) => l.id === "ebitda")!;
    expect(lb.observado).toBe(true);
    expect(lb.periodo.realizado).toBe(50); // 200 − 150
    expect(eb.observado).toBe(true);
    expect(eb.periodo.realizado).toBe(20); // 50 − 30
  });

  it("porLinha tem precedência sobre o total do grupo", () => {
    const orc = [linha("receita-total", "Receita", "subtotal", 100)];
    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: orc,
      statusMes: status(),
      realizado: {
        meses: ["2026-01"],
        porGrupo: { receita: { "2026-01": 80 } },
        porLinha: { "receita-total": { "2026-01": 95 } },
      },
      janela: { de: "2026-01", ate: "2026-01" },
    });
    expect(r.linhas[0]!.periodo.realizado).toBe(95);
  });

  it("sem balancete, cai na projeção e nada fica marcado como observado", () => {
    const { orc, projecao } = cenario();
    const r = calcularOrcadoRealizado({
      snapshot: snapshotBase(orc),
      dreRealizada: projecao,
      statusMes: status(),
      janela,
    });
    expect(r.linhas[0]!.observado).toBe(false);
    expect(r.linhas[0]!.semaforo).toBe("neutro");
  });
});

// ── Congelamento ───────────────────────────────────────────────────────────

describe("congelarOrcamento", () => {
  it("clona a DRE — o snapshot não muda quando o modelo vivo muda", () => {
    const dre = [linha("receita", "(+) Receita Bruta", "receita", 100)];
    const snap = congelarOrcamento({
      id: "s1",
      nome: "Orçamento 2026",
      cenario: "Base",
      mesInicial: "2026-01",
      horizonteMeses: 12,
      dre,
    });

    dre[0]!.valores["2026-01"] = 999_999;

    expect(snap.dre[0]!.valores["2026-01"]).toBe(100);
  });

  it("guarda o cenário ativo no momento do congelamento", () => {
    const snap = congelarOrcamento({
      id: "s1",
      nome: "Orçamento 2026",
      cenario: "Otimista",
      mesInicial: "2026-01",
      horizonteMeses: 12,
      dre: [],
    });
    expect(snap.cenario).toBe("Otimista");
    expect(snap.criadoEm).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
