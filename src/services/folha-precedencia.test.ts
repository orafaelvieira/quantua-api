import { describe, it, expect } from "vitest";
import { calcularModelo } from "./model-engine";
import type { BlocoModelo } from "./model-engine";

/**
 * PESSOAS MANDA NA FOLHA DO CENTRO DE CUSTO (pedido de 28/07/2026).
 *
 * A mesma folha podia ser orçada em dois lugares — digitada na linha "Salários
 * e encargos (Comercial)" da grade E detalhada por posição na aba Pessoas — e
 * as duas somavam na DRE. Aqui está a regra provada: com posição cadastrada no
 * CC, vale Pessoas; sem posição, vale o digitado; e o digitado NUNCA é apagado.
 */

const MESES = ["2026-01", "2026-02"];
const CC_COMERCIAL = "cc-comercial";
const CC_MARKETING = "cc-marketing";

function modelo(opts: { posicoes?: Array<Record<string, unknown>> }): BlocoModelo[] {
  return [
    {
      id: "b-rec", tipo: "receitas", nome: "Receitas", ordem: 0, ativo: true,
      config: {
        linhasReceita: [{
          id: "lin1", nome: "Vendas", nodeRaiz: "n1",
          nodes: [{ id: "n1", nome: "Vendas", tipo: "serie", unidade: "R$", params: { modoPreenchimento: "simples", valorMensal: 100_000, crescimentoAnual: 0 } }],
        }],
      },
    },
    {
      id: "b-desp", tipo: "despesas", nome: "Despesas", ordem: 1, ativo: true,
      config: {
        linhasCusto: [
          // Folha digitada em DOIS centros de custo…
          { id: "f-com", nome: "Salários e encargos (Comercial)", modo: "serie", centroCustoId: CC_COMERCIAL, valores: { "2026-01": 50_000, "2026-02": 50_000 }, destino: { conta: "Despesas com Pessoas", sinal: "soma" } },
          { id: "f-mkt", nome: "Salários e encargos (Marketing)", modo: "serie", centroCustoId: CC_MARKETING, valores: { "2026-01": 20_000, "2026-02": 20_000 }, destino: { conta: "Despesas com Pessoas", sinal: "soma" } },
          // …e uma despesa comum, que nada tem a ver com folha.
          { id: "viagens", nome: "Viagens e hospedagem", modo: "serie", centroCustoId: CC_COMERCIAL, valores: { "2026-01": 7_000, "2026-02": 7_000 } },
        ],
      },
    },
    {
      id: "b-folha", tipo: "folha", nome: "Pessoas", ordem: 2, ativo: true,
      // Encargos ZERADOS na tabela do bloco (é ela que manda, não o campo da
      // posição) — aqui interessa a regra de precedência, não a folha bruta.
      config: { posicoes: opts.posicoes ?? [], encargosPorContrato: { clt: 0 } },
    },
  ] as unknown as BlocoModelo[];
}

/** Só uma posição, no Comercial: 2 pessoas × 10.000, sem encargos nem benefícios. */
const POSICAO_COMERCIAL = {
  id: "p1", nome: "Vendedor", classificacao: "despesa", tipoContrato: "clt", encargosPct: 0,
  salarioMensal: 10_000, modoQtd: "mes", qtdMeses: { "2026-01": 2, "2026-02": 2 },
  centroCustoId: CC_COMERCIAL,
};

const somaMeses = (s: Record<string, number> | undefined) => MESES.reduce((t, m) => t + (s?.[m] ?? 0), 0);
const rodar = (blocks: BlocoModelo[]) => calcularModelo({ mesInicial: "2026-01", horizonteMeses: 2, blocks });

describe("aba Pessoas assume a folha do centro de custo", () => {
  it("SEM posição cadastrada, vale o que foi digitado na grade", () => {
    const r = rodar(modelo({}));
    expect(r.linhasFolhaSubstituidas).toEqual([]);
    expect(somaMeses(r.linhasCalculadas["f-com"])).toBe(100_000); // 50k × 2 meses
    expect(somaMeses(r.linhasCalculadas["f-mkt"])).toBe(40_000);
  });

  it("COM posição no Comercial, a linha daquele CC sai do cálculo — sem folha em dobro", () => {
    const r = rodar(modelo({ posicoes: [POSICAO_COMERCIAL] }));
    expect(r.linhasFolhaSubstituidas.map((l) => l.id)).toEqual(["f-com"]);
    expect(somaMeses(r.linhasCalculadas["f-com"])).toBe(0);   // digitada saiu do cálculo
    expect(somaMeses(r.linhasCalculadas["f-mkt"])).toBe(40_000); // CC sem posição continua valendo

    // "Despesas com Pessoas" na DRE = folha de Pessoas (2 × 10.000 × 2 meses)
    // + a linha de Marketing, que continua digitada. Nada da linha do Comercial.
    const pessoas = r.dre.find((l) => /despesas com pessoas/i.test(l.nome));
    expect(somaMeses(pessoas?.valores)).toBe(40_000 + 40_000);
  });

  it("a folha por centro de custo volta calculada (é o número que a grade mostra)", () => {
    const r = rodar(modelo({ posicoes: [POSICAO_COMERCIAL] }));
    expect(somaMeses(r.folhaPorCentro[CC_COMERCIAL])).toBe(40_000);
    expect(r.folhaPorCentro[CC_MARKETING]).toBeUndefined();
  });

  it("despesa que NÃO é folha nunca é tocada, mesmo no CC coberto", () => {
    const r = rodar(modelo({ posicoes: [POSICAO_COMERCIAL] }));
    expect(somaMeses(r.linhasCalculadas["viagens"])).toBe(14_000);
  });

  it("posição SEM centro de custo não substitui linha nenhuma (folha corporativa)", () => {
    const r = rodar(modelo({ posicoes: [{ ...POSICAO_COMERCIAL, centroCustoId: null }] }));
    expect(r.linhasFolhaSubstituidas).toEqual([]);
    expect(somaMeses(r.linhasCalculadas["f-com"])).toBe(100_000);
  });

  it("tirar a posição devolve o valor digitado: o que o analista escreveu não se perde", () => {
    const com = rodar(modelo({ posicoes: [POSICAO_COMERCIAL] }));
    expect(somaMeses(com.linhasCalculadas["f-com"])).toBe(0);
    const sem = rodar(modelo({})); // mesmas linhas digitadas, sem Pessoas
    expect(somaMeses(sem.linhasCalculadas["f-com"])).toBe(100_000);
  });
});
