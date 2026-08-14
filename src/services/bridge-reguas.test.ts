import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { paresComparaveis, buildPontesVariacao } from "./bridge-variacao";

/**
 * RÉGUAS DE COMPARAÇÃO com balancete mensal (pergunta do dono, 14/08/2026).
 * A DRE do balancete é ACUMULADA no exercício — o que se compara com o quê é a
 * decisão que separa análise de número inventado.
 */
const A2024 = "31/12/2024";
const M03 = "31/03/2026";
const M04 = "30/04/2026";
const M05 = "31/05/2026";
const M05_ANT = "31/05/2025";

const dreL = (conta: string, subtotal: boolean, v: Record<string, number>): DRELineItem => ({ conta, subtotal, editado: false, valores: v });
const bpL = (classificacao: string, conta: string, nivel: number, v: Record<string, number>): BPLineItem => ({ classificacao, conta, nivel, editado: false, valores: v });

/** DRE YTD na convenção canônica: receita entra como INPUT (Receita Bruta +
 *  Impostos); "Receita Líquida" é subtotal calculado — é assim que o fold monta,
 *  e a ponte soma os inputs, não os subtotais. */
function cenarioMensal() {
  const dre: DRELineItem[] = [
    dreL("Receita Bruta", false, { [M03]: 330, [M04]: 440, [M05]: 560, [M05_ANT]: 500, [A2024]: 1300 }),
    dreL("Impostos s/ Faturamento", false, { [M03]: -30, [M04]: -40, [M05]: -60, [M05_ANT]: -50, [A2024]: -100 }),
    dreL("Receita Líquida", true, { [M03]: 300, [M04]: 400, [M05]: 500, [M05_ANT]: 450, [A2024]: 1200 }),
    dreL("Custo Operacional", false, { [M03]: -120, [M04]: -160, [M05]: -200, [M05_ANT]: -180, [A2024]: -480 }),
    dreL("Lucro Bruto", true, { [M03]: 180, [M04]: 240, [M05]: 300, [M05_ANT]: 270, [A2024]: 720 }),
    dreL("Despesas com Pessoas", false, { [M03]: -60, [M04]: -80, [M05]: -100, [M05_ANT]: -95, [A2024]: -240 }),
    dreL("EBITDA", true, { [M03]: 120, [M04]: 160, [M05]: 200, [M05_ANT]: 175, [A2024]: 480 }),
    dreL("Lucro Líquido", true, { [M03]: 90, [M04]: 120, [M05]: 150, [M05_ANT]: 130, [A2024]: 360 }),
  ];
  const bp: BPLineItem[] = [
    bpL("AO", "Contas a Receber - CP", 2, { [M03]: 100, [M04]: 110, [M05]: 120, [M05_ANT]: 105, [A2024]: 90 }),
    bpL("PO", "Fornecedores - CP", 2, { [M03]: 40, [M04]: 45, [M05]: 50, [M05_ANT]: 42, [A2024]: 38 }),
    bpL("PL", "Patrimônio Líquido", 1, { [M03]: 500, [M04]: 520, [M05]: 540, [M05_ANT]: 480, [A2024]: 460 }),
    bpL("AT", "Ativo Total", 0, { [M03]: 800, [M04]: 830, [M05]: 860, [M05_ANT]: 780, [A2024]: 760 }),
  ];
  const periodos = [A2024, M05_ANT, M03, M04, M05];
  const arvoresBalancete = [M05_ANT, M03, M04, M05].map((periodo) => ({ periodo }));
  return { bp, dre, periodos, arvoresBalancete, balancetes: arvoresBalancete };
}

describe("paresComparaveis — o que pode ser comparado com o quê", () => {
  it("meses consecutivos do mesmo exercício viram régua MÊS", () => {
    const pares = paresComparaveis(cenarioMensal());
    const mom = pares.filter((p) => p.regua === "mes");
    expect(mom.map((p) => `${p.de}→${p.ate}`)).toContain(`${M04}→${M05}`);
    expect(mom.every((p) => p.mesesJanela === 1)).toBe(true);
  });

  it("mesmo mês do ano anterior vira régua ANO-A-ANO, com a janela em meses", () => {
    const pares = paresComparaveis(cenarioMensal());
    const yoy = pares.find((p) => p.regua === "ano-a-ano");
    expect(yoy).toBeTruthy();
    expect(yoy!.de).toBe(M05_ANT);
    expect(yoy!.ate).toBe(M05);
    expect(yoy!.mesesJanela).toBe(5); // YTD de maio dos dois lados
  });

  it("ano cheio × YTD parcial NUNCA vira par (janela diferente)", () => {
    const pares = paresComparaveis(cenarioMensal());
    expect(pares.some((p) => p.de === A2024 && p.ate === M05_ANT)).toBe(false);
    expect(pares.some((p) => p.de === A2024)).toBe(false);
  });

  it("série só anual continua produzindo régua EXERCÍCIO", () => {
    const dre = [dreL("Receita Líquida", true, { "31/12/2023": 900, [A2024]: 1200 }), dreL("EBITDA", true, { "31/12/2023": 300, [A2024]: 480 })];
    const pares = paresComparaveis({ dre, periodos: ["31/12/2023", A2024] });
    expect(pares).toHaveLength(1);
    expect(pares[0]!.regua).toBe("exercicio");
  });

  it("PAR NÃO SEQUENCIAL existe (2022 × 2024) e vem marcado como salto", () => {
    const periodos = ["31/12/2022", "31/12/2023", A2024];
    const dre = [dreL("Receita Líquida", true, { "31/12/2022": 700, "31/12/2023": 900, [A2024]: 1200 })];
    const pares = paresComparaveis({ dre, periodos });
    const distante = pares.find((p) => p.de === "31/12/2022" && p.ate === A2024);
    expect(distante).toBeTruthy();
    expect(distante!.saltaPeriodos).toBe(true);
    // Os consecutivos continuam existindo e NÃO são salto.
    expect(pares.find((p) => p.de === "31/12/2023" && p.ate === A2024)?.saltaPeriodos).toBe(false);
  });

  it("o padrão nunca é um par que salta períodos", () => {
    const periodos = ["31/12/2022", "31/12/2023", A2024];
    const dre = [
      dreL("Receita Bruta", false, { "31/12/2022": 750, "31/12/2023": 950, [A2024]: 1300 }),
      dreL("Receita Líquida", true, { "31/12/2022": 700, "31/12/2023": 900, [A2024]: 1200 }),
      dreL("EBITDA", true, { "31/12/2022": 200, "31/12/2023": 300, [A2024]: 480 }),
    ];
    const p = buildPontesVariacao({ dre, periodos })!;
    expect(p.par).toEqual({ de: "31/12/2023", ate: A2024 });
  });

  it("lacuna de DADOS continua bloqueando, mesmo com par distante", () => {
    // 2023 não existe na série E a série declara a lacuna: 2022 × 2024 atravessa vazio.
    const periodos = ["31/12/2022", A2024];
    const dre = [dreL("Receita Líquida", true, { "31/12/2022": 700, [A2024]: 1200 })];
    const serie = { ok: false, lacunas: [{ de: "01/01/2023", ate: "31/12/2023", rotulo: "2023" }] };
    expect(paresComparaveis({ dre, periodos, serie })).toHaveLength(0);
  });
});

describe("buildPontesVariacao com régua", () => {
  it("MoM usa a DRE DO MÊS (não o acumulado): abr→mai compara 100 de EBITDA do mês", () => {
    const d = cenarioMensal();
    const p = buildPontesVariacao(d, { par: { de: M04, ate: M05 } })!;
    expect(p.regua).toBe("mes");
    // EBITDA do mês: abril = 160−120 = 40; maio = 200−160 = 40.
    expect(p.ponteEbitda?.inicial).toBeCloseTo(40, 6);
    expect(p.ponteEbitda?.final).toBeCloseTo(40, 6);
    expect(p.ponteEbitda?.prova.fecha).toBe(true);
  });

  it("ano-a-ano compara os ACUMULADOS (YTD × YTD), sem mensalizar", () => {
    const d = cenarioMensal();
    const p = buildPontesVariacao(d, { par: { de: M05_ANT, ate: M05 } })!;
    expect(p.regua).toBe("ano-a-ano");
    expect(p.ponteEbitda?.inicial).toBeCloseTo(175, 6);
    expect(p.ponteEbitda?.final).toBeCloseTo(200, 6);
    expect(p.ponteEbitda?.prova.fecha).toBe(true);
  });

  it("sem pedido, prefere ANO-A-ANO (neutraliza sazonalidade) e lista as opções", () => {
    const p = buildPontesVariacao(cenarioMensal())!;
    expect(p.regua).toBe("ano-a-ano");
    expect(p.disponiveis.length).toBeGreaterThan(1);
    expect(p.disponiveis.some((x) => x.regua === "mes")).toBe(true);
  });

  it("par não comparável pedido pelo analista é recusado com motivo", () => {
    const p = buildPontesVariacao(cenarioMensal(), { par: { de: A2024, ate: M05 } })!;
    expect(p.par).toBeNull();
    expect(p.bloqueio).toMatch(/não é comparável/i);
  });
});
