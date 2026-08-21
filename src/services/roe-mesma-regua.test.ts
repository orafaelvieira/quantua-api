import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { buildPontesVariacao } from "./bridge-variacao";
import { calculateIndicators } from "./indicator-calculator";

/**
 * UMA RÉGUA SÓ DE RETORNO (dono, 20/08/2026: "não pode ter diferenças de
 * metodologias entre o Documento e os Indicadores").
 *
 * A aba Indicadores calcula ROE por `retornoDe` (indicator-calculator.ts:420):
 * lucro ANUALIZADO sobre base MÉDIA entre o período e o anterior. O DuPont do
 * relatório usava lucro cru sobre PL da data de fechamento. Medido na Belagro,
 * o MESMO relatório publicava 40,09% no DuPont e 31,44% nos Indicadores para
 * 31/12/2025 — 8,6 pontos de diferença.
 *
 * A armadilha que escondeu isso por meses: no PRIMEIRO período da série não há
 * anterior, a base média vira pontual e as duas réguas COINCIDEM. Quem conferisse
 * só 2024 veria 80,05% nos dois lados e concluiria que estava tudo certo — foi
 * exatamente o que aconteceu. Por isso esta bancada compara TODOS os períodos.
 */

const P = ["2024", "30/11/2025", "31/12/2025"];
const v = (...x: number[]) => Object.fromEntries(P.map((p, i) => [p, x[i]]));
const bpL = (conta: string, classificacao: string, nivel: number, ...x: number[]): BPLineItem =>
  ({ conta, classificacao, nivel, editado: false, valores: v(...x) } as BPLineItem);
const dreL = (conta: string, subtotal: boolean, ...x: number[]): DRELineItem =>
  ({ conta, subtotal, editado: false, valores: v(...x) });

/** Recorte da série REAL da Belagro (bancada-belagro.test.ts). */
function serie() {
  const bp: BPLineItem[] = [
    bpL("Ativo Total", "AT", 0, 75_810_000, 161_370_000, 121_200_000),
    bpL("Ativo Circulante", "AC", 1, 55_740_000, 134_720_000, 94_800_000),
    bpL("Caixa e Equivalentes de Caixa", "AF", 2, 2_102_807, 5_336_133, 997_963),
    bpL("Contas a Receber - CP", "AO", 2, 37_800_000, 99_550_000, 67_750_000),
    bpL("Passivo Total", "PT", 0, 75_810_000, 161_370_000, 121_200_000),
    bpL("Passivo Circulante", "PC", 1, 55_470_000, 125_070_000, 100_120_000),
    bpL("Fornecedores - CP", "PO", 2, 19_390_000, 75_120_000, 42_880_000),
    bpL("Empréstimos e Financiamentos - CP", "PF", 2, 27_920_000, 49_090_000, 56_390_000),
    bpL("Patrimônio Líquido", "PL", 1, 14_468_543, 24_956_057, 16_101_635),
  ];
  const dre: DRELineItem[] = [
    dreL("Receita Bruta", false, 650_000_000, 805_000_000, 815_000_000),
    dreL("Receita Líquida", true, 592_042_364, 732_760_000, 741_125_792),
    dreL("Custo Operacional", false, -547_420_000, -678_150_000, -685_050_000),
    dreL("EBITDA", true, 15_440_000, 12_910_000, 13_800_000),
    dreL("Lucro Líquido", true, 11_581_723, 9_669_025, 6_454_351),
  ];
  return { bp, dre, periodos: [...P] };
}

/** ROE que a aba Indicadores publica para um período. */
function roeDosIndicadores(periodo: string): number {
  const d = serie();
  const inds = calculateIndicators(d.bp, d.dre, d.periodos);
  const roe = inds.find((i) => i.nome.startsWith("ROE"))!;
  const v = roe.valores[periodo];
  expect(typeof v, `ROE dos Indicadores em ${periodo}`).toBe("number");
  return v as number;
}

describe("o DuPont do relatório usa a régua dos Indicadores", () => {
  it("coincidem em TODOS os períodos, não só no primeiro", () => {
    let comparados = 0;
    for (const par of [["2024", "30/11/2025"], ["2024", "31/12/2025"], ["30/11/2025", "31/12/2025"]] as const) {
      const p = buildPontesVariacao({ ...serie() } as never, { par: { de: par[0], ate: par[1] } });
      const dup = p?.dupont;
      if (!dup) continue;
      expect(dup.roeInicial, `ROE inicial do par ${par[0]}→${par[1]}`).toBeCloseTo(roeDosIndicadores(par[0]), 5);
      expect(dup.roeFinal, `ROE final do par ${par[0]}→${par[1]}`).toBeCloseTo(roeDosIndicadores(par[1]), 5);
      comparados++;
    }
    // GUARDA DA GUARDA: se nenhum par virasse ponte, o laço acima passaria verde
    // sem comparar nada — selo sem medida é o que esta bancada existe para evitar.
    expect(comparados, "nenhum par virou ponte: o teste não testou nada").toBeGreaterThan(0);
  });

  it("a comparação cobre mais de um período (senão a armadilha volta)", () => {
    // No PRIMEIRO período da série não há anterior e a base média vira pontual —
    // ali as duas réguas tendem a coincidir por construção. Conferir só o
    // primeiro não prova nada; foi assim que a divergência passou despercebida.
    const alvos = ["2024", "30/11/2025", "31/12/2025"];
    const valores = alvos.map((p) => roeDosIndicadores(p));
    expect(new Set(valores.map((v) => v.toFixed(6))).size, "os períodos precisam ter ROE distinto").toBeGreaterThan(1);
  });

  it("no ÚLTIMO período a régua nova NÃO é a antiga (senão o teste não testa nada)", () => {
    const antiga = 6_454_351 / 16_101_635; // LL ÷ PL da data de fechamento = 40,09%
    const p = buildPontesVariacao({ ...serie() } as never, { par: { de: "2024", ate: "31/12/2025" } })!;
    const nova = p.dupont!.roeFinal;
    expect(Math.abs(nova - antiga), "a régua nova precisa diferir da antiga aqui").toBeGreaterThan(0.05);
  });

  it("a identidade Margem × Giro × Alavancagem continua fechando no ROE", () => {
    const p = buildPontesVariacao({ ...serie() } as never, { par: { de: "2024", ate: "31/12/2025" } });
    const d = p?.dupont;
    if (!d?.componentes) return;
    const [m0, m1] = d.componentes.margem, [g0, g1] = d.componentes.giro, [a0, a1] = d.componentes.alavancagem;
    expect(m0 * g0 * a0).toBeCloseTo(d.roeInicial, 4);
    expect(m1 * g1 * a1).toBeCloseTo(d.roeFinal, 4);
    // e a soma dos efeitos reproduz a variação
    const soma = d.efeitos.margem + d.efeitos.giro + d.efeitos.alavancagem + d.efeitos.residuo;
    // efeitos e ROE saem arredondados a 6 casas na RAZÃO: 1e-6 é o piso.
    expect(soma).toBeCloseTo(d.roeFinal - d.roeInicial, 5);
  });
});
