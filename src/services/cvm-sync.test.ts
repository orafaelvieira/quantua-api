import { describe, it, expect } from "vitest";
import { modoDoSnapshot, type ProgressoHistorico } from "./cvm-sync";

/**
 * A auto-retomada precisa repetir a MESMA operação que morreu. Retomar uma
 * ressincronização de arquivo único pelo caminho do histórico é um NO-OP silencioso
 * (o histórico pula arquivo que já tem CvmSyncState) — foi o que deixou o DFP 2025
 * eternamente "interrompido" sem nunca refazer nada.
 */
const snap = (p: Partial<ProgressoHistorico>): ProgressoHistorico => ({
  emAndamento: false, total: 0, feitos: 0, atual: null,
  ok: [], pulados: [], erros: [], iniciadoEm: null, terminadoEm: null, ...p,
});

describe("modoDoSnapshot", () => {
  it("respeita o modo gravado no snapshot", () => {
    expect(modoDoSnapshot(snap({ modo: "arquivo", alvo: { tipo: "dfp", ano: 2025 }, total: 1 })))
      .toEqual({ modo: "arquivo", alvo: { tipo: "dfp", ano: 2025 } });
    expect(modoDoSnapshot(snap({ modo: "recalc", total: 17 })))
      .toEqual({ modo: "recalc", alvo: null });
    expect(modoDoSnapshot(snap({ modo: "historico", total: 32, atual: "dfp_2015" })))
      .toEqual({ modo: "historico", alvo: null });
  });

  // O snapshot travado no banco no momento do deploy NÃO tem o campo `modo`: sem a
  // inferência, a retomada continuaria caindo no histórico e não refaria nada.
  it("infere arquivo único em snapshot legado (total=1 + id de arquivo)", () => {
    expect(modoDoSnapshot(snap({ total: 1, feitos: 0, atual: "dfp_2025" })))
      .toEqual({ modo: "arquivo", alvo: { tipo: "dfp", ano: 2025 } });
    expect(modoDoSnapshot(snap({ total: 1, feitos: 0, atual: "itr_2026" })))
      .toEqual({ modo: "arquivo", alvo: { tipo: "itr", ano: 2026 } });
  });

  it("não confunde o histórico com arquivo único", () => {
    // mesmo formato em `atual`, mas o total revela que é o plano inteiro
    expect(modoDoSnapshot(snap({ total: 32, feitos: 11, atual: "dfp_2015" })))
      .toEqual({ modo: "historico", alvo: null });
  });

  it("infere recálculo geral pelo rótulo do passo", () => {
    expect(modoDoSnapshot(snap({ total: 17, feitos: 3, atual: "recalc_2019" })))
      .toEqual({ modo: "recalc", alvo: null });
  });

  it("sem pista nenhuma, cai no histórico (comportamento anterior)", () => {
    expect(modoDoSnapshot(snap({ total: 32, atual: null }))).toEqual({ modo: "historico", alvo: null });
    expect(modoDoSnapshot(snap({ total: 1, atual: "coisa_estranha" }))).toEqual({ modo: "historico", alvo: null });
  });
});
