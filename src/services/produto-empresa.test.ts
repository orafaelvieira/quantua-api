import { describe, it, expect } from "vitest";
import {
  normalizarRotulo,
  montarRotulo,
  proximaVersao,
  vigenteDoEnvelope,
  tipoCompativel,
  dataBaseDoModelo,
  dataBaseDoIbr,
  nomeDocumento,
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
  it("ano SÓ no orçamento — o exercício é o que identifica o produto", () => {
    expect(montarRotulo("orcamento", { periodo: "2027" }).rotulo).toBe("Orçamento 2027");
    // IBR e Valuation são relação contínua: o ano é da VERSÃO (data-base).
    expect(montarRotulo("valuation", { periodo: "2026" }).rotulo).toBe("Valuation");
    expect(montarRotulo("ibr", { periodo: "2025" }).rotulo).toBe("IBR");
  });

  it("complemento livre entra com travessão", () => {
    expect(montarRotulo("valuation", { complemento: "disputa judicial" }).rotulo)
      .toBe("Valuation — disputa judicial");
    expect(montarRotulo("business-plan", { complemento: "Sementes" }).rotulo)
      .toBe("Business Plan — Sementes");
  });

  it("IBR e Valuation são só o prefixo quando não há complemento", () => {
    expect(montarRotulo("ibr").rotulo).toBe("IBR");
    expect(montarRotulo("valuation").rotulo).toBe("Valuation");
  });

  it("BP sem complemento é ERRO — não identifica iniciativa nenhuma", () => {
    const r = montarRotulo("business-plan", {});
    expect(r.erro).toBeTruthy();
    expect(r.rotulo).toBe("");
  });

  it("Orçamento sem ano é ERRO — o exercício é obrigatório", () => {
    expect(montarRotulo("orcamento", {}).erro).toBeTruthy();
    expect(montarRotulo("orcamento", { periodo: "26" }).erro).toBeTruthy();
  });
});

// ── Data-base e nome do documento ──────────────────────────────────────────

describe("dataBaseDoModelo", () => {
  it("é o fecho do mês ANTERIOR ao início da projeção", () => {
    expect(dataBaseDoModelo("2026-07")).toBe("jun/26");
    expect(dataBaseDoModelo("2026-01")).toBe("dez/25"); // vira o ano
  });
  it("entrada inválida devolve vazio, sem estourar", () => {
    expect(dataBaseDoModelo("")).toBe("");
    expect(dataBaseDoModelo("2026")).toBe("");
  });
});

describe("dataBaseDoIbr", () => {
  it("usa o ÚLTIMO período extraído — a data do último documento", () => {
    expect(dataBaseDoIbr("31/12/2023 a 31/12/2024 a 31/12/2025")).toBe("dez/25");
    expect(dataBaseDoIbr("31/12/2023 a 31/05/2026")).toBe("mai/26");
  });
  it("exercícios sem dia/mês fecham em dezembro", () => {
    expect(dataBaseDoIbr("2023 · 2024 · 2025")).toBe("dez/25");
  });
  it("sem período declarado, não inventa data", () => {
    expect(dataBaseDoIbr(null)).toBe("");
    expect(dataBaseDoIbr("")).toBe("");
  });
});

describe("nomeDocumento", () => {
  it("IBR e Valuation: produto + empresa + data-base + versão", () => {
    expect(nomeDocumento({ tipo: "ibr", empresa: "Move Farma Repro", dataBase: "dez/25", versao: 2 }))
      .toBe("IBR Move Farma Repro · dez/25 · v2");
    expect(nomeDocumento({ tipo: "valuation", empresa: "Move Farma Repro", dataBase: "jun/26", versao: 1 }))
      .toBe("Valuation Move Farma Repro · jun/26 · v1");
  });

  it("Orçamento carrega o ANO do exercício, não a data-base", () => {
    expect(nomeDocumento({ tipo: "orcamento", empresa: "Move Farma Repro", ano: "2026", versao: 1 }))
      .toBe("Orçamento Move Farma Repro 2026 · v1");
  });

  it("Business Plan carrega a INICIATIVA", () => {
    expect(nomeDocumento({ tipo: "business-plan", empresa: "Move Farma Repro", complemento: "Nova filial", versao: 1 }))
      .toBe("Business Plan Move Farma Repro — Nova filial · v1");
  });

  it("sem data-base conhecida, o nome sai sem ela — nunca com data chutada", () => {
    expect(nomeDocumento({ tipo: "ibr", empresa: "Move Farma Repro", versao: 1 }))
      .toBe("IBR Move Farma Repro · v1");
  });

  it("complemento opcional separa mandatos distintos do mesmo tipo", () => {
    expect(nomeDocumento({ tipo: "valuation", empresa: "Belagro", complemento: "disputa judicial", dataBase: "dez/25", versao: 3 }))
      .toBe("Valuation Belagro — disputa judicial · dez/25 · v3");
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
