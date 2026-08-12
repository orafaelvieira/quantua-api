/**
 * A trava é a diferença entre "duplo clique custa nada" e "duplo clique paga a
 * extração duas vezes na instância única". O fake abaixo imita a semântica do
 * UPDATE condicional do Postgres — se um destes testes cair, a corrida voltou.
 */
import { describe, it, expect } from "vitest";
import { tomarTravaExtracao, motivoTravaNegada, TRAVA_EXTRACAO_MIN } from "./trava-extracao";

const AGORA = new Date("2026-08-11T12:00:00Z");
const minAtras = (m: number) => new Date(AGORA.getTime() - m * 60_000);

/** Banco de UMA linha que avalia o `where` do updateMany como o Postgres faria. */
function fakePrisma(linha: { status: string; updatedAt: Date }) {
  const casa = (where: any): boolean => {
    const ors: any[] = where.OR;
    return ors.some((o) => {
      if (o.status?.notIn) return !o.status.notIn.includes(linha.status);
      if (typeof o.status === "string" && o.status !== linha.status) return false;
      if (o.updatedAt?.lt) return linha.updatedAt < o.updatedAt.lt;
      return true;
    });
  };
  return {
    linha,
    analysis: {
      updateMany: async ({ where, data }: any) => {
        if (!casa(where)) return { count: 0 };
        linha.status = data.status;
        linha.updatedAt = AGORA;
        return { count: 1 };
      },
    },
  };
}

describe("tomar a trava de extração", () => {
  it.each(["Rascunho", "Revisão necessária", "Pronta para gerar", "Erro", "Em análise"])(
    "assume quando o IBR está em %s",
    async (status) => {
      const db = fakePrisma({ status, updatedAt: minAtras(1) });
      expect(await tomarTravaExtracao(db, "a1", AGORA)).toBe(true);
      expect(db.linha.status).toBe("Extraindo");
    },
  );

  it("NEGA quando já há uma extração em curso (o caso do duplo clique)", async () => {
    const db = fakePrisma({ status: "Extraindo", updatedAt: minAtras(1) });
    expect(await tomarTravaExtracao(db, "a1", AGORA)).toBe(false);
  });

  it.each(["Concluída", "Cancelada"])("NEGA %s mesmo que velhíssima (desfecho, não trabalho)", async (status) => {
    const db = fakePrisma({ status, updatedAt: minAtras(60 * 24 * 30) });
    expect(await tomarTravaExtracao(db, "a1", AGORA)).toBe(false);
    expect(db.linha.status).toBe(status);
  });

  it("REASSUME extração órfã (instância morreu no meio) — trava sem escape trava o analista", async () => {
    const db = fakePrisma({ status: "Extraindo", updatedAt: minAtras(TRAVA_EXTRACAO_MIN + 1) });
    expect(await tomarTravaExtracao(db, "a1", AGORA)).toBe(true);
  });

  it("não reassume extração VIVA que ainda está dentro do prazo", async () => {
    const db = fakePrisma({ status: "Extraindo", updatedAt: minAtras(TRAVA_EXTRACAO_MIN - 1) });
    expect(await tomarTravaExtracao(db, "a1", AGORA)).toBe(false);
  });

  it("dois POSTs concorrentes: exatamente UM ganha", async () => {
    const db = fakePrisma({ status: "Rascunho", updatedAt: minAtras(1) });
    const [a, b] = await Promise.all([
      tomarTravaExtracao(db, "a1", AGORA),
      tomarTravaExtracao(db, "a1", AGORA),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("motivo do 409", () => {
  it("em curso: manda esperar", () => expect(motivoTravaNegada("Extraindo")).toMatch(/aguarde/i));
  it("concluída: manda criar nova versão", () => expect(motivoTravaNegada("Concluída")).toMatch(/nova versão/i));
  it("status desconhecido não fica sem explicação", () => expect(motivoTravaNegada("Arquivada")).toContain("Arquivada"));
});
