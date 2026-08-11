/**
 * CONSERVAÇÃO DE VALOR — "o dinheiro que entra do documento tem de sair nas
 * linhas". A prova que faltava para a garantia "zero erro" na montagem do BP.
 *
 * Caso real (Belagro, produção): "Distribuição de Lucros" (R$ 4,7 mi em 2023 e
 * R$ 8,8 mi em 2024) entrava no TOTAL do passivo e não aparecia em NENHUMA
 * linha — o PL era o único grupo sem conta-balde. O balanço continuava
 * fechando (os dois lados usam o subtotal) e o Fluxo de Caixa quebrava sem
 * causa visível.
 */
import { describe, it, expect } from "vitest";
import { foldBP } from "./ai-extraction";
import { DEFAULT_BP_MODEL, buildBPModel } from "./account-mapper";

const arvore = (itensPL: Array<{ nome: string; valor: number }>) => ({
  "31/12/2024": {
    grupos: {
      "Ativo Circulante": [{ nome: "Caixa", valor: 1000 }],
      "Passivo Circulante": [{ nome: "Fornecedores", valor: 400 }],
      "Patrimônio Líquido": [{ nome: "Capital Social", valor: 600 }, ...itensPL],
    },
  },
});

describe("conservação de valor no fold do BP", () => {
  it("documento simples: o que entrou é exatamente o que saiu", () => {
    const r = foldBP(arvore([]) as never, ["31/12/2024"], [], DEFAULT_BP_MODEL);
    const k = r.conservacao[0]!;
    expect(k.ok).toBe(true);
    expect(k.entrou).toBeCloseTo(k.saiu, 2);
    expect(k.vazamentos).toEqual([]);
  });

  it("conta do PL fora do modelo VAI PARA A LINHA-BALDE (era o vazamento da Belagro)", () => {
    const r = foldBP(arvore([{ nome: "Distribuição de Lucros", valor: -4712776.46 }]) as never, ["31/12/2024"], [], DEFAULT_BP_MODEL);
    const balde = r.bp.find((l) => l.conta === "Outras Contas do Patrimônio Líquido");
    // o lado passivo tem convenção de sinal própria — o que importa é o VALOR chegar à linha
    expect(Math.abs(balde?.valores["31/12/2024"] ?? 0)).toBeCloseTo(4712776.46, 2);
    expect(r.conservacao[0]!.ok).toBe(true);
  });

  it("modelo SEM conta-balde no grupo: o vazamento é DECLARADO e nomeia a conta", () => {
    // Empresa que editou o BP e removeu os "Outros…" do PL (copy-on-write).
    const semBalde = buildBPModel(DEFAULT_BP_MODEL.lines.filter((l) => !/^outr/i.test(l.conta)));
    const r = foldBP(arvore([{ nome: "Distribuição de Lucros", valor: -4712776.46 }]) as never, ["31/12/2024"], [], semBalde);
    const k = r.conservacao[0]!;
    expect(k.ok).toBe(false);
    expect(k.vazamentos[0]!.conta).toBe("Distribuição de Lucros");
    expect(Math.abs(k.vazamentos[0]!.valor)).toBeCloseTo(4712776.46, 2);
    expect(k.vazamentos[0]!.motivo).toMatch(/não tem conta-balde/);
  });

  it("a diferença medida é exatamente o valor que ficou de fora", () => {
    const semBalde = buildBPModel(DEFAULT_BP_MODEL.lines.filter((l) => !/^outr/i.test(l.conta)));
    const k = foldBP(arvore([{ nome: "Distribuição de Lucros", valor: -1234.56 }]) as never, ["31/12/2024"], [], semBalde).conservacao[0]!;
    expect(Math.abs(k.diferenca)).toBeCloseTo(1234.56, 2);
  });
});
