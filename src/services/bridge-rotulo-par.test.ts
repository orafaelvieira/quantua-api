import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { buildPontesVariacao, paresComparaveis, rotuloPeriodoSrv } from "./bridge-variacao";

/**
 * RÓTULO DO PAR NA PONTE — defeito visto no IBR da Belagro (dono, 20/08/2026).
 *
 * O relatório publicava, na MESMA frase: "Período comparado: 2024 → 12/2025" e
 * "Decomposição do par 12/2024 → 12/2025". O dono perguntou o óbvio: "o dez aqui
 * é acumulado 2025 ou apenas dez/25? Estamos pegando todo 2024 e comparando
 * apenas com dez/25?".
 *
 * O NÚMERO sempre esteve certo: o par 31/12/2024 → 31/12/2025 numa série de
 * balancete é régua "ano-a-ano" com `mesesJanela: 12` — YTD de 12 meses dos dois
 * lados, ou seja, exercício cheio contra exercício cheio. Quem mentia era o
 * rótulo: `ehMes` saía de `regua !== "exercicio"`, e a régua "ano-a-ano" caía no
 * formato de mês. Esta bancada trava as duas pontas: a régua e o rótulo.
 */
const D2024 = "31/12/2024";
const N2025 = "30/11/2025";
const D2025 = "31/12/2025";
const M2026 = "31/05/2026";

const dreL = (conta: string, subtotal: boolean, v: Record<string, number>): DRELineItem => ({ conta, subtotal, editado: false, valores: v });
const bpL = (classificacao: string, conta: string, nivel: number, v: Record<string, number>): BPLineItem => ({ classificacao, conta, nivel, editado: false, valores: v });

/** Série da Belagro em miniatura: balancete mensal, com dois dezembros fechados
 *  e um YTD parcial de maio/2026 na ponta (o período que NÃO entra no par). */
function cenarioBelagro() {
  const dre: DRELineItem[] = [
    dreL("Receita Bruta", false, { [D2024]: 600, [N2025]: 690, [D2025]: 744, [M2026]: 330 }),
    dreL("Impostos s/ Faturamento", false, { [D2024]: -60, [N2025]: -69, [D2025]: -74, [M2026]: -33 }),
    dreL("Receita Líquida", true, { [D2024]: 540, [N2025]: 621, [D2025]: 670, [M2026]: 297 }),
    dreL("Custo Operacional", false, { [D2024]: -480, [N2025]: -558, [D2025]: -604, [M2026]: -267 }),
    dreL("Lucro Bruto", true, { [D2024]: 60, [N2025]: 63, [D2025]: 66, [M2026]: 30 }),
    dreL("Despesas com Pessoas", false, { [D2024]: -45, [N2025]: -48, [D2025]: -52, [M2026]: -22 }),
    dreL("EBITDA", true, { [D2024]: 15, [N2025]: 15, [D2025]: 14, [M2026]: 8 }),
    dreL("Lucro Líquido", true, { [D2024]: 12, [N2025]: 7, [D2025]: 6, [M2026]: 3 }),
  ];
  const bp: BPLineItem[] = [
    bpL("AO", "Contas a Receber - CP", 2, { [D2024]: 38, [N2025]: 62, [D2025]: 68, [M2026]: 80 }),
    bpL("PO", "Fornecedores - CP", 2, { [D2024]: 17, [N2025]: 36, [D2025]: 38, [M2026]: 44 }),
    bpL("PL", "Patrimônio Líquido", 1, { [D2024]: 15, [N2025]: 15, [D2025]: 16, [M2026]: 18 }),
    bpL("AT", "Ativo Total", 0, { [D2024]: 60, [N2025]: 78, [D2025]: 84, [M2026]: 96 }),
  ];
  const periodos = [D2024, N2025, D2025, M2026];
  const arvoresBalancete = periodos.map((periodo) => ({ periodo }));
  return { bp, dre, periodos, arvoresBalancete, balancetes: arvoresBalancete };
}

describe("rotuloPeriodoSrv — dezembro é o ano, salvo quando o valor é do mês", () => {
  it("dezembro sem flag vira o ANO", () => {
    expect(rotuloPeriodoSrv(D2025)).toBe("2025");
    expect(rotuloPeriodoSrv("31/12/2026")).toBe("2026");
  });

  it("mês que não é dezembro vira MM/AAAA mesmo sem flag", () => {
    expect(rotuloPeriodoSrv(M2026)).toBe("05/2026");
  });

  it("a flag ehMes existe para o valor DO MÊS isolado — aí dezembro é 12/AAAA", () => {
    expect(rotuloPeriodoSrv(D2025, true)).toBe("12/2025");
  });
});

describe("o par de dois dezembros é exercício contra exercício", () => {
  it("a régua é ano-a-ano com janela de 12 MESES nos dois lados", () => {
    const yoy = paresComparaveis(cenarioBelagro()).find((p) => p.regua === "ano-a-ano" && p.de === D2024 && p.ate === D2025);
    expect(yoy).toBeTruthy();
    // A PROVA de que a comparação NÃO é "ano cheio contra dezembro".
    expect(yoy!.mesesJanela).toBe(12);
  });

  it("o valor comparado é o ACUMULADO do ano, não o mês de dezembro", () => {
    const p = buildPontesVariacao(cenarioBelagro(), { par: { de: D2024, ate: D2025 } })!;
    expect(p.regua).toBe("ano-a-ano");
    // EBITDA acumulado: 2024 = 15, 2025 = 14. Se fosse dezembro isolado, seria ~1.
    expect(p.ponteEbitda?.inicial).toBeCloseTo(15, 6);
    expect(p.ponteEbitda?.final).toBeCloseTo(14, 6);
  });

  it("O RÓTULO acompanha: 2024 → 2025, nunca 12/2024 → 12/2025", () => {
    const p = buildPontesVariacao(cenarioBelagro())!;
    expect(p.par?.de).toBe(D2024);      // a CHAVE do dado não muda
    expect(p.par?.ate).toBe(D2025);
    expect(p.par?.rotuloDe).toBe("2024");
    expect(p.par?.rotuloAte).toBe("2025");
  });

  it("o aviso do período de fora usa o mesmo rótulo e não repete o par", () => {
    const p = buildPontesVariacao(cenarioBelagro())!;
    expect(p.avisoPar).toContain("05/2026");
    // O cabeçalho já diz "Período comparado: 2024 → 2025" — repetir ali era ruído,
    // e repetia ERRADO.
    expect(p.avisoPar).not.toContain("12/2025");
    expect(p.avisoPar).not.toContain("12/2024");
    expect(p.avisoPar).not.toContain("31/12/");
  });
});

describe("controle — o que já estava certo continua certo", () => {
  it("régua MÊS mantém o rótulo de mês nos dois lados", () => {
    const p = buildPontesVariacao(cenarioBelagro(), { par: { de: N2025, ate: D2025 } });
    // Só asserta o rótulo quando o MoM foi possível (precisa do mês isolado).
    if (p?.regua === "mes") {
      expect(p.par?.rotuloDe).toBe("11/2025");
      expect(p.par?.rotuloAte).toBe("12/2025");
    } else {
      expect(p?.bloqueio).toBeTruthy(); // sem mês isolado, o par não vira ponte
    }
  });

  it("série só anual continua rotulando pelo ano", () => {
    const periodos = ["31/12/2023", D2024];
    const dre = [
      dreL("Receita Bruta", false, { "31/12/2023": 950, [D2024]: 1300 }),
      dreL("Receita Líquida", true, { "31/12/2023": 900, [D2024]: 1200 }),
      dreL("EBITDA", true, { "31/12/2023": 300, [D2024]: 480 }),
    ];
    const p = buildPontesVariacao({ dre, periodos })!;
    expect(p.regua).toBe("exercicio");
    expect(p.par?.rotuloDe).toBe("2023");
    expect(p.par?.rotuloAte).toBe("2024");
  });
});

describe("o que vai para o cliente não fala da cozinha", () => {
  /**
   * REGRA DO DONO (20/08/2026): "Não coloque frases no documento do cliente que
   * sejam informação interna da Quantua." O aviso do par publicava "Há pares
   * terminando em 05/2026 no seletor" — o seletor é da NOSSA tela, o cliente não
   * tem seletor nenhum. Regra sem trava volta na próxima frase escrita com pressa.
   */
  const COZINHA = [/seletor/i, /na tela/i, /no sistema/i, /reprocess/i, /pipeline/i, /job/i, /fallback/i, /payload/i, /banco de dados/i, /PR/];

  /** Série com um par MoM disponível na ponta (04→05/2026): é ESSE o caso em que
   *  o motor tentava ser prestativo e citava o seletor. Sem 30/04/2026 na série
   *  o ramo nunca roda e o teste passa sem testar nada. */
  function comParNaPonta() {
    const d = cenarioBelagro();
    const A26 = "30/04/2026";
    const dre = d.dre.map((l) => ({ ...l, valores: { ...l.valores, [A26]: (l.valores[M2026] ?? 0) * 0.8 } }));
    const bp = d.bp.map((l) => ({ ...l, valores: { ...l.valores, [A26]: (l.valores[M2026] ?? 0) * 0.9 } }));
    const periodos = [D2024, N2025, D2025, A26, M2026];
    return { ...d, dre, bp, periodos, arvoresBalancete: periodos.map((periodo) => ({ periodo })) };
  }

  it("o aviso do par não menciona a ferramenta", () => {
    const p = buildPontesVariacao(comParNaPonta())!;
    // Guarda da guarda: se o aviso não sair, o teste não testou nada.
    expect(p.avisoPar, "o aviso precisa existir para o teste valer").toBeTruthy();
    expect(p.avisoPar).toContain("05/2026");
    for (const re of COZINHA) expect(p.avisoPar!).not.toMatch(re);
  });

  it("nem o bloqueio, nem as notas das pontes", () => {
    const p = buildPontesVariacao(cenarioBelagro())!;
    const textos = [p.bloqueio, p.ponteNcg?.nota, p.dupont?.nota, p.hierarquiaCaixa?.premissas?.nota]
      .filter((t): t is string => typeof t === "string");
    for (const t of textos) for (const re of COZINHA) expect(t).not.toMatch(re);
  });
});
