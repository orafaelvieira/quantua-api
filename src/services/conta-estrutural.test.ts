/**
 * Travas do dicionário contra "veneno" (conta agregada → folha). Caso-âncora:
 * Fibracabos "Grau 4" — EXIGÍVEL A CURTO PRAZO classificado como folha.
 */
import { describe, it, expect } from "vitest";
import { ehTermoAgregado, ehDestinoFolha, avaliaBloqueioEstrutural } from "./conta-estrutural";

describe("conta-estrutural — trava anti-veneno do dicionário", () => {
  it("reconhece agregados de grupo (não-folha)", () => {
    for (const n of [
      "EXIGÍVEL A CURTO PRAZO", "Exigível a Longo Prazo", "Passivo Exigível",
      "Passivo Circulante", "ATIVO NÃO CIRCULANTE", "Ativo Total", "Passivo Total",
      "Patrimônio Líquido", "Patrimônio Líquido Consolidado", "CRÉDITOS", "Outras Obrigações",
    ]) {
      expect(ehTermoAgregado(n), `${n} deveria ser agregado`).toBe(true);
    }
  });

  it("NÃO marca folhas legítimas como agregado (evita falso-positivo)", () => {
    for (const n of [
      "Obrigações Trabalhistas a Pagar", "Obrigações Fiscais", "Fornecedores a Pagar",
      "Realizável a Longo Prazo", "Outros Créditos", "Estoques", "Duplicatas a Receber",
      "Impostos a Recuperar", "Adiantamentos Diversos",
    ]) {
      expect(ehTermoAgregado(n), `${n} NÃO deveria ser agregado`).toBe(false);
    }
  });

  it("distingue folha de grupo no modelo", () => {
    expect(ehDestinoFolha("Fornecedores - CP")).toBe(true);
    expect(ehDestinoFolha("Obrigações Trabalhistas - CP")).toBe(true);
    expect(ehDestinoFolha("Passivo Circulante")).toBe(false); // grupo
    expect(ehDestinoFolha("Ativo Total")).toBe(false); // total
  });

  it("BLOQUEIA agregado → folha (o veneno: Exigível a Curto Prazo → Obrigações Trabalhistas)", () => {
    const r = avaliaBloqueioEstrutural("EXIGÍVEL A CURTO PRAZO", "Obrigações Trabalhistas - CP");
    expect(r.bloqueado).toBe(true);
    expect(r.motivo).toContain("AGRUPAMENTO");
  });

  it("PERMITE agregado → seu próprio grupo (Exigível a Curto Prazo → Passivo Circulante)", () => {
    expect(avaliaBloqueioEstrutural("EXIGÍVEL A CURTO PRAZO", "Passivo Circulante").bloqueado).toBe(false);
  });

  it("PERMITE folha → folha (fluxo normal)", () => {
    expect(avaliaBloqueioEstrutural("FORNECEDORES A PAGAR", "Fornecedores - CP").bloqueado).toBe(false);
    expect(avaliaBloqueioEstrutural("SALÁRIOS A PAGAR", "Obrigações Trabalhistas - CP").bloqueado).toBe(false);
  });

  it("PERMITE Realizável a Longo Prazo → sua folha (não é veneno — é catch-all do modelo)", () => {
    expect(avaliaBloqueioEstrutural("REALIZÁVEL A LONGO PRAZO", "Realizável a Longo Prazo").bloqueado).toBe(false);
  });
});
