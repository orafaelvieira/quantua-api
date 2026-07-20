import { describe, it, expect } from "vitest";
import {
  normalizarRotulo,
  montarRotulo,
  proximaVersao,
  vigenteDoEnvelope,
  tipoCompativel,
  VersaoEnvelope,
} from "./produto-empresa";

// ── Normalização (trava anti-duplicata) ────────────────────────────────────

describe("normalizarRotulo", () => {
  it("faz colidir as grafias que na prática são o mesmo produto", () => {
    // O caso que motivou a trava: "Orçamento 2026" e "Orcamento-2026".
    expect(normalizarRotulo("Orçamento 2026")).toBe(normalizarRotulo("Orcamento-2026"));
    expect(normalizarRotulo("Business Plan — Sementes")).toBe(normalizarRotulo("business plan - sementes"));
    expect(normalizarRotulo("  Valuation   2026 ")).toBe(normalizarRotulo("VALUATION 2026"));
  });

  it("não colide produtos genuinamente diferentes", () => {
    expect(normalizarRotulo("Orçamento 2026")).not.toBe(normalizarRotulo("Orçamento 2027"));
    expect(normalizarRotulo("Business Plan — Sementes")).not.toBe(normalizarRotulo("Business Plan — Filial Sorriso"));
  });

  it("entrada vazia devolve vazio, sem estourar", () => {
    expect(normalizarRotulo("")).toBe("");
    expect(normalizarRotulo("   ")).toBe("");
  });
});

// ── Rótulo híbrido ─────────────────────────────────────────────────────────

describe("montarRotulo", () => {
  it("prefixo do sistema + período", () => {
    expect(montarRotulo("orcamento", { periodo: "2027" }).rotulo).toBe("Orçamento 2027");
    expect(montarRotulo("valuation", { periodo: "2026" }).rotulo).toBe("Valuation 2026");
  });

  it("complemento livre entra com travessão", () => {
    expect(montarRotulo("valuation", { periodo: "2026", complemento: "venda da empresa" }).rotulo)
      .toBe("Valuation 2026 — venda da empresa");
    expect(montarRotulo("business-plan", { complemento: "Sementes" }).rotulo)
      .toBe("Business Plan — Sementes");
  });

  it("IBR pode ser só o prefixo", () => {
    expect(montarRotulo("ibr").rotulo).toBe("IBR");
  });

  it("BP sem complemento é ERRO — não identifica iniciativa nenhuma", () => {
    const r = montarRotulo("business-plan", {});
    expect(r.erro).toBeTruthy();
    expect(r.rotulo).toBe("");
  });
});

// ── Versão monotônica ──────────────────────────────────────────────────────

describe("proximaVersao", () => {
  it("primeira versão do envelope é 1", () => {
    expect(proximaVersao([])).toBe(1);
  });

  it("sempre max+1 — nunca reaproveita número", () => {
    expect(proximaVersao([{ produtoVersao: 1 }, { produtoVersao: 2 }])).toBe(3);
    // Buraco na sequência (v2 saiu do envelope) não faz a próxima virar 2.
    expect(proximaVersao([{ produtoVersao: 1 }, { produtoVersao: 3 }])).toBe(4);
  });
});

// ── Vigência ───────────────────────────────────────────────────────────────

describe("vigenteDoEnvelope", () => {
  const versoes: VersaoEnvelope[] = [
    { id: "a1", produtoVersao: 1, status: "Cancelada" },
    { id: "a2", produtoVersao: 2, status: "Concluída" },
    { id: "a3", produtoVersao: 3, status: "Revisão necessária" },
  ];

  it("IBR: derivada — a maior versão CONCLUÍDA, não a maior versão", () => {
    // v3 existe mas não concluiu → vigente é v2. Quando v3 concluir, troca sozinha.
    expect(vigenteDoEnvelope("ibr", null, versoes)).toBe("a2");
    const depois = versoes.map((v) => (v.id === "a3" ? { ...v, status: "Concluída" } : v));
    expect(vigenteDoEnvelope("ibr", null, depois)).toBe("a3");
  });

  it("IBR: ponteiro manual é IGNORADO — a regra é a automática", () => {
    expect(vigenteDoEnvelope("ibr", "a1", versoes)).toBe("a2");
  });

  it("IBR sem nenhuma concluída → sem vigente (nunca chuta)", () => {
    const nenhuma = versoes.map((v) => ({ ...v, status: "Rascunho" }));
    expect(vigenteDoEnvelope("ibr", null, nenhuma)).toBeNull();
  });

  it("demais produtos: ponteiro manual manda", () => {
    expect(vigenteDoEnvelope("valuation", "a1", versoes)).toBe("a1");
    expect(vigenteDoEnvelope("orcamento", null, versoes)).toBeNull();
  });

  it("ponteiro para registro que saiu do envelope → null, não um chute", () => {
    expect(vigenteDoEnvelope("valuation", "fantasma", versoes)).toBeNull();
  });
});

// ── Compatibilidade de tipo ────────────────────────────────────────────────

describe("tipoCompativel", () => {
  it("envelope de IBR só aceita Analysis", () => {
    expect(tipoCompativel("ibr", "analysis").ok).toBe(true);
    expect(tipoCompativel("ibr", "model", "valuation").ok).toBe(false);
  });

  it("envelopes de modelo casam pelo objetivo", () => {
    expect(tipoCompativel("valuation", "model", "valuation").ok).toBe(true);
    expect(tipoCompativel("orcamento", "model", "orcamento").ok).toBe(true);
    expect(tipoCompativel("business-plan", "model", "business-plan").ok).toBe(true);
    expect(tipoCompativel("valuation", "model", "business-plan").ok).toBe(false);
    expect(tipoCompativel("orcamento", "model", "valuation").ok).toBe(false);
  });

  it("objetivo 'ambos' serve a valuation E a orçamento — é o que o nome diz", () => {
    expect(tipoCompativel("valuation", "model", "ambos").ok).toBe(true);
    expect(tipoCompativel("orcamento", "model", "ambos").ok).toBe(true);
    expect(tipoCompativel("business-plan", "model", "ambos").ok).toBe(false);
  });

  it("Analysis não entra em envelope de modelo", () => {
    expect(tipoCompativel("valuation", "analysis").ok).toBe(false);
  });
});
