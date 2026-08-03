/**
 * ONDE o alerta é empilhado importa tanto quanto o texto dele.
 *
 * A revisão adversarial (03/08/2026) mostrou que um alerta empilhado depois do
 * `if (f.ok) continue` NUNCA rodaria para um balancete cujo fechamento PASSA —
 * e é exatamente esse o caso do grupo-espelho: ele só é detectado quando tudo
 * fecha. O resultado seria dinheiro saindo da DRE com selo verde e zero rastro.
 */
import { describe, it, expect } from "vitest";
import { aplicarProvasBalancete } from "./analyses";

const validacaoVazia = () => ({ alertas: [] as any[], reconciliacaoDRE: { verificada: false, ok: false } }) as any;
const balancete = (extra: Record<string, unknown>) => ({
  docId: "d1", nome: "Balancete Budel.pdf",
  provas: {
    fechamento: { ativo: 1200, passivo: 900, resultadoAcumulado: 300, delta: 0, ok: true },
    linhas: { total: 10, coerentes: 10, ok: true, incoerentes: [] },
    exercicioEncerrado: false,
  },
  ...extra,
});

describe("alerta do grupo excluído sai mesmo com o fechamento OK", () => {
  it("emite aviso na área Balancete quando há grupo fora das demonstrações", () => {
    const v = validacaoVazia();
    aplicarProvasBalancete(v, {
      balancetes: [balancete({ gruposExcluidos: [{ nome: "CENTRO DE CUSTOS", contas: 39, movimento: 5910206.67 }] })],
    });
    const aviso = v.alertas.find((a: any) => a.area === "Balancete" && a.tipo === "aviso" && a.mensagem.includes("CENTRO DE CUSTOS"));
    expect(aviso).toBeDefined();
    expect(aviso.mensagem).toContain("FORA da DRE");
    expect(aviso.mensagem).toContain("5.910.206,67"); // o valor que saiu, por extenso
  });

  it("sem grupo excluído não inventa aviso", () => {
    const v = validacaoVazia();
    aplicarProvasBalancete(v, { balancetes: [balancete({ gruposExcluidos: [] })] });
    expect(v.alertas.filter((a: any) => a.tipo === "aviso" && a.area === "Balancete")).toHaveLength(0);
  });

  it("extração antiga (campo ausente) não quebra", () => {
    const v = validacaoVazia();
    expect(() => aplicarProvasBalancete(v, { balancetes: [balancete({})] })).not.toThrow();
  });
});
