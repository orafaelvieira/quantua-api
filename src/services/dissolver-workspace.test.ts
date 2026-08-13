import { describe, it, expect } from "vitest";
import { planejarDissolucaoWorkspace, LinhaDicionario } from "./dissolver-workspace";
import { resolverCascataDicionario } from "./dicionario-escopo";

/**
 * Cada cenário aqui veio de uma FALHA que a revisão adversarial provou na
 * primeira versão do plano de migração. A prova embutida (simulação por
 * empresa) é o que os revisores exigiram no lugar de argumento.
 */

let seq = 0;
const linha = (
  nome: string, destino: string, escopo: "g" | "w" | `e:${string}`,
  extra: Partial<LinhaDicionario> = {},
): LinhaDicionario => ({
  id: `l${++seq}`,
  nomeOriginal: nome,
  contaDestino: destino,
  grupoConta: extra.grupoConta ?? "Ativo Circulante",
  tipo: extra.tipo ?? "BP",
  userId: escopo === "g" ? null : "u1",
  companyId: escopo.startsWith("e:") ? escopo.slice(2) : null,
  ...extra,
});

describe("planejarDissolucaoWorkspace", () => {
  it("workspace redundante (mesmo destino do global): cancela sem cópia nenhuma", () => {
    const p = planejarDissolucaoWorkspace(
      [linha("Clientes", "Contas a Receber - CP", "g"), linha("Clientes", "Contas a Receber - CP", "w")],
      ["c1", "c2"],
    );
    expect(p.copias).toHaveLength(0);
    expect(p.conflitos).toHaveLength(0);
    expect(p.aplicavel).toBe(true);
    expect(p.workspaceIds).toHaveLength(1);
  });

  it("workspace com destino DIFERENTE do global: vira cópia em CADA empresa (o número de hoje se preserva)", () => {
    const p = planejarDissolucaoWorkspace(
      [linha("Adiantamentos", "Despesas Ant. / Adiantamentos - Ativo", "g"), linha("Adiantamentos", "Outros Créditos a Receber - CP", "w")],
      ["c1", "c2", "c3"],
    );
    expect(p.aplicavel).toBe(true);
    expect(p.copias).toHaveLength(3);
    expect(new Set(p.copias.map((c) => c.companyId))).toEqual(new Set(["c1", "c2", "c3"]));
    expect(p.copias.every((c) => c.contaDestino === "Outros Créditos a Receber - CP")).toBe(true);
  });

  it("empresa com override próprio NÃO recebe cópia — o dela já vence o workspace", () => {
    const p = planejarDissolucaoWorkspace(
      [
        linha("Adiantamentos", "Despesas Ant. / Adiantamentos - Ativo", "g"),
        linha("Adiantamentos", "Outros Créditos a Receber - CP", "w"),
        linha("Adiantamentos", "Estoques - CP", "e:c1"),
      ],
      ["c1", "c2"],
    );
    expect(p.aplicavel).toBe(true);
    expect(p.copias.map((c) => c.companyId)).toEqual(["c2"]);
  });

  it("VETO __IGNORAR__ do workspace vira cópia — a conta não volta ao balanço (falha nº3 dos revisores)", () => {
    const p = planejarDissolucaoWorkspace(
      [linha("Circulante", "Caixa e Equivalentes de Caixa", "g"), linha("Circulante", "__IGNORAR__", "w")],
      ["c1", "c2"],
    );
    expect(p.aplicavel).toBe(true);
    expect(p.copias).toHaveLength(2);
    expect(p.copias.every((c) => c.contaDestino === "__IGNORAR__")).toBe(true);

    // Prova independente: aplicar as cópias reproduz o veto empresa a empresa.
    for (const companyId of ["c1", "c2"]) {
      const depois = [
        linha("Circulante", "Caixa e Equivalentes de Caixa", "g"),
        ...p.copias.filter((c) => c.companyId === companyId).map((c) =>
          linha(c.nomeOriginal, c.contaDestino, `e:${companyId}`, { grupoConta: c.grupoConta ?? undefined })),
      ];
      const r = resolverCascataDicionario(depois, "BP");
      expect(r.some((e) => e.contaDestino === "__IGNORAR__")).toBe(true);
    }
  });

  it("DRE: cópia preserva o destino mesmo com o filtro por nome que roda depois da cascata", () => {
    const dre = (nome: string, destino: string, escopo: "g" | "w") =>
      linha(nome, destino, escopo, { tipo: "DRE", grupoConta: destino });
    const p = planejarDissolucaoWorkspace(
      [dre("Fretes", "Despesas com Vendas", "g"), dre("Fretes", "Custo Operacional", "w")],
      ["c1"],
    );
    expect(p.aplicavel).toBe(true);
    expect(p.copias).toHaveLength(1);
    expect(p.copias[0].contaDestino).toBe("Custo Operacional");
  });

  it("sem camada workspace: plano vazio e aplicável (idempotente)", () => {
    const p = planejarDissolucaoWorkspace([linha("Caixa", "Caixa e Equivalentes de Caixa", "g")], ["c1"]);
    expect(p.workspaceIds).toHaveLength(0);
    expect(p.copias).toHaveLength(0);
    expect(p.aplicavel).toBe(true);
  });

  it("entrada de workspace CANCELADA fica fora do plano", () => {
    const p = planejarDissolucaoWorkspace(
      [linha("Clientes", "Contas a Receber - CP", "g"), linha("Clientes", "Estoques - CP", "w", { revisao: "cancelada" })],
      ["c1"],
    );
    expect(p.workspaceIds).toHaveLength(0);
    expect(p.copias).toHaveLength(0);
  });

  it("a PROVA roda para toda empresa e o plano só é aplicável com todas idênticas", () => {
    const p = planejarDissolucaoWorkspace(
      [
        linha("Clientes", "Contas a Receber - CP", "g"),
        linha("Clientes", "Outros Créditos a Receber - CP", "w"),
        linha("Fornecedores", "Fornecedores", "g", { grupoConta: "Passivo Circulante" }),
      ],
      ["c1", "c2", "c3", "c4"],
    );
    expect(p.provas).toHaveLength(4);
    expect(p.provas.every((x) => x.identico)).toBe(true);
    expect(p.aplicavel).toBe(true);
  });
});
