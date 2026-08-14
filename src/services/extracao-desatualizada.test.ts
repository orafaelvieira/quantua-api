import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./base-contabil", () => ({
  insumosDaBase: vi.fn(),
  diferencasDaMarca: vi.fn(() => ["o dicionário da empresa mudou depois desta extração"]),
}));

import { medirExtracaoDesatualizada } from "./extracao-desatualizada";
import { insumosDaBase } from "./base-contabil";

const doc = (over: Partial<{ id: string; nome: string; tipo: string; status: string; fixadoDeId: string | null; createdAt: Date }> = {}) => ({
  id: "d1", nome: "DRE 2024.pdf", tipo: "DRE", status: "Processado", fixadoDeId: "pool-1",
  createdAt: new Date("2026-01-01T00:00:00Z"), ...over,
});

describe("medirExtracaoDesatualizada", () => {
  beforeEach(() => vi.clearAllMocks());

  it("caminho da base: marca diferente = desatualizada, com motivo conferível", async () => {
    (insumosDaBase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ marca: "marca-NOVA", docs: [] });
    const r = await medirExtracaoDesatualizada(
      { companyId: "c1", dadosEstruturados: { marcaBase: "marca-velha" }, documents: [doc()] },
      ["u1"],
    );
    expect(r.desatualizada).toBe(true);
    expect(r.motivos[0]).toContain("dicionário");
  });

  it("caminho da base: MESMA marca = atualizada (documentos idênticos não bastam para acender)", async () => {
    (insumosDaBase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ marca: "marca-igual", docs: [] });
    const r = await medirExtracaoDesatualizada(
      { companyId: "c1", dadosEstruturados: { marcaBase: "marca-igual" }, documents: [doc()] },
      ["u1"],
    );
    expect(r.desatualizada).toBe(false);
  });

  it("falha ao medir NÃO barra a geração (erro de infra não vira trava)", async () => {
    (insumosDaBase as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("banco fora"));
    const r = await medirExtracaoDesatualizada(
      { companyId: "c1", dadosEstruturados: { marcaBase: "x" }, documents: [doc()] },
      ["u1"],
    );
    expect(r.desatualizada).toBe(false);
  });

  it("caminho antigo: documento que entrou DEPOIS da extração acende; herdado não", async () => {
    const dados = { extraidoEm: "2026-02-01T00:00:00Z" };
    const depois = await medirExtracaoDesatualizada(
      { companyId: "c1", dadosEstruturados: dados, documents: [doc({ fixadoDeId: null, createdAt: new Date("2026-03-01T00:00:00Z") })] },
      ["u1"],
    );
    expect(depois.desatualizada).toBe(true);
    expect(depois.motivos[0]).toContain("DRE 2024.pdf");

    // Herdado (Processado + fixadoDeId) carrega a própria extração: não conta.
    const herdado = await medirExtracaoDesatualizada(
      { companyId: "c1", dadosEstruturados: dados, documents: [doc({ createdAt: new Date("2026-03-01T00:00:00Z") })] },
      ["u1"],
    );
    expect(herdado.desatualizada).toBe(false);
  });

  it("material complementar e documento substituído não acendem o aviso", async () => {
    const dados = { extraidoEm: "2026-02-01T00:00:00Z" };
    const r = await medirExtracaoDesatualizada(
      {
        companyId: "c1", dadosEstruturados: dados,
        documents: [
          doc({ tipo: "Material complementar", fixadoDeId: null, createdAt: new Date("2026-03-01T00:00:00Z") }),
          doc({ id: "d2", status: "Substituído", fixadoDeId: null, createdAt: new Date("2026-03-01T00:00:00Z") }),
        ],
      },
      ["u1"],
    );
    expect(r.desatualizada).toBe(false);
  });

  it("sem dados estruturados não há o que medir", async () => {
    const r = await medirExtracaoDesatualizada({ companyId: "c1", dadosEstruturados: null, documents: [] }, ["u1"]);
    expect(r.desatualizada).toBe(false);
  });
});
