import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../db/client", () => ({
  prisma: {
    document: { findMany: vi.fn() },
    analysis: { findUnique: vi.fn() },
  },
}));

import { conjuntoJaUsadoEmOutroIBR } from "./fixacao-pool";
import { prisma } from "../db/client";

const docs = prisma.document.findMany as unknown as ReturnType<typeof vi.fn>;
const analise = prisma.analysis.findUnique as unknown as ReturnType<typeof vi.fn>;

/** Documentos DESTE IBR (1ª chamada) e os de outros IBRs (2ª chamada). */
function cenario(meus: string[], outros: Array<{ analysisId: string; fixadoDeId: string; nome: string; status: string; produtoId: string | null }>, meuProdutoId: string | null) {
  docs.mockReset();
  docs
    .mockResolvedValueOnce(meus.map((id) => ({ fixadoDeId: id, tipo: "DRE" })))
    .mockResolvedValueOnce(outros.map((o) => ({
      analysisId: o.analysisId, fixadoDeId: o.fixadoDeId, tipo: "DRE",
      analysis: { nome: o.nome, status: o.status, produtoId: o.produtoId },
    })));
  analise.mockResolvedValue({ produtoId: meuProdutoId });
}

describe("garantia 7 — conjunto já usado em outro IBR", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("NOVA VERSÃO do mesmo produto NÃO dispara (versionar é reusar os mesmos documentos)", async () => {
    // v3 (produto P1) contra a v2 (mesmo produto P1) — o caso do DUNAMYS.
    cenario(
      ["pool-1", "pool-2"],
      [
        { analysisId: "v2", fixadoDeId: "pool-1", nome: "IBR DUNAMYS · dez/24 · v2", status: "Concluída", produtoId: "P1" },
        { analysisId: "v2", fixadoDeId: "pool-2", nome: "IBR DUNAMYS · dez/24 · v2", status: "Concluída", produtoId: "P1" },
      ],
      "P1",
    );
    expect(await conjuntoJaUsadoEmOutroIBR("v3", "emp-1")).toBeNull();
  });

  it("IBR de OUTRO produto com o mesmo conjunto CONTINUA disparando (a garantia segue viva)", async () => {
    cenario(
      ["pool-1", "pool-2"],
      [
        { analysisId: "outro", fixadoDeId: "pool-1", nome: "IBR paralelo", status: "Concluída", produtoId: "P9" },
        { analysisId: "outro", fixadoDeId: "pool-2", nome: "IBR paralelo", status: "Concluída", produtoId: "P9" },
      ],
      "P1",
    );
    const r = await conjuntoJaUsadoEmOutroIBR("v3", "emp-1");
    expect(r?.nome).toBe("IBR paralelo");
    expect(r?.documentos).toBe(2);
  });

  it("IBR SOLTO (sem produto) segue protegido — sem produtoId não há como saber que é versão", async () => {
    cenario(
      ["pool-1"],
      [{ analysisId: "outro", fixadoDeId: "pool-1", nome: "IBR solto", status: "Concluída", produtoId: null }],
      null,
    );
    expect((await conjuntoJaUsadoEmOutroIBR("meu", "emp-1"))?.nome).toBe("IBR solto");
  });

  it("IBR cancelado não conta como entrega", async () => {
    cenario(
      ["pool-1"],
      [{ analysisId: "outro", fixadoDeId: "pool-1", nome: "IBR cancelado", status: "Cancelada", produtoId: "P9" }],
      "P1",
    );
    expect(await conjuntoJaUsadoEmOutroIBR("meu", "emp-1")).toBeNull();
  });

  it("conjunto PARCIAL (o outro não cobre tudo) não dispara", async () => {
    cenario(
      ["pool-1", "pool-2"],
      [{ analysisId: "outro", fixadoDeId: "pool-1", nome: "IBR parcial", status: "Concluída", produtoId: "P9" }],
      "P1",
    );
    expect(await conjuntoJaUsadoEmOutroIBR("meu", "emp-1")).toBeNull();
  });
});
