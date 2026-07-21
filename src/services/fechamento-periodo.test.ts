import { describe, it, expect } from "vitest";
import {
  derivarDocumentosLogicos,
  estadoDoPeriodo,
  estaFechado,
  podeFechar,
  podeReabrir,
  retificacoesAposFechamento,
  periodosFaltantes,
  DocFechamento,
  FechamentoRegistro,
} from "./fechamento-periodo";

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function doc(p: Partial<DocFechamento> & { tipo: string }): DocFechamento {
  seq += 1;
  return {
    id: p.id ?? `d${seq}`,
    nome: p.nome ?? `${p.tipo} ${seq}`,
    competencia: p.competencia ?? null,
    versao: p.versao ?? 1,
    status: p.status ?? "Processado",
    substituidoPorId: p.substituidoPorId ?? null,
    createdAt: p.createdAt ?? new Date(2026, 5, seq), // jun/2026, dias sequenciais
    ...{ tipo: p.tipo },
  };
}

function reg(p: Partial<FechamentoRegistro> = {}): FechamentoRegistro {
  return { periodo: p.periodo ?? "2026-06", fechadoEm: p.fechadoEm ?? null, reabertoEm: p.reabertoEm ?? null };
}

// ── Documentos lógicos ─────────────────────────────────────────────────────

describe("derivarDocumentosLogicos", () => {
  it("o cenário dia 5/7/10: cadeia de substituição vira UM documento com 3 versões", () => {
    const v1 = doc({ id: "v1", tipo: "Balancete", competencia: "2026-06", status: "Substituído", substituidoPorId: "v2", createdAt: new Date("2026-07-05") });
    const v2 = doc({ id: "v2", tipo: "Balancete", competencia: "2026-06", status: "Substituído", substituidoPorId: "v3", createdAt: new Date("2026-07-07") });
    const v3 = doc({ id: "v3", tipo: "Balancete", competencia: "2026-06", createdAt: new Date("2026-07-10") });

    const logicos = derivarDocumentosLogicos([v3, v1, v2]); // ordem embaralhada de propósito
    expect(logicos).toHaveLength(1);
    expect(logicos[0]!.versoes.map((v) => v.id)).toEqual(["v1", "v2", "v3"]);
    expect(logicos[0]!.vigente.id).toBe("v3");
    expect(logicos[0]!.competencia).toBe("2026-06");
  });

  it("reenvio SEM usar Substituir ainda empilha: mesma (tipo, competência) funde", () => {
    // O contador mandou o balancete de jun/26 duas vezes como uploads avulsos.
    const a = doc({ id: "a", tipo: "Balancete", competencia: "2026-06", createdAt: new Date("2026-07-05") });
    const b = doc({ id: "b", tipo: "Balancete", competencia: "2026-06", createdAt: new Date("2026-07-09") });

    const logicos = derivarDocumentosLogicos([a, b]);
    expect(logicos).toHaveLength(1);
    expect(logicos[0]!.versoes.map((v) => v.id)).toEqual(["a", "b"]);
    expect(logicos[0]!.vigente.id).toBe("b");
  });

  it("SEM competência não empilha por tipo: DRE 2023 e DRE 2024 são documentos distintos", () => {
    const dre23 = doc({ tipo: "DRE", nome: "DRE 2023" });
    const dre24 = doc({ tipo: "DRE", nome: "DRE 2024" });
    expect(derivarDocumentosLogicos([dre23, dre24])).toHaveLength(2);
  });

  it("competências de meses diferentes não fundem", () => {
    const jun = doc({ tipo: "Balancete", competencia: "2026-06" });
    const jul = doc({ tipo: "Balancete", competencia: "2026-07" });
    expect(derivarDocumentosLogicos([jun, jul])).toHaveLength(2);
  });

  it("competência fora do padrão YYYY-MM é tratada como ausente (não agrupa)", () => {
    const a = doc({ tipo: "Balancete", competencia: "junho/26" });
    const b = doc({ tipo: "Balancete", competencia: "junho/26" });
    expect(derivarDocumentosLogicos([a, b])).toHaveLength(2);
  });

  it("vigente ignora versões substituídas mesmo se forem as mais novas por engano", () => {
    const v1 = doc({ id: "v1", tipo: "Balancete", competencia: "2026-06", createdAt: new Date("2026-07-08") });
    const v0 = doc({ id: "v0", tipo: "Balancete", competencia: "2026-06", status: "Substituído", substituidoPorId: "v1", createdAt: new Date("2026-07-05") });
    const logicos = derivarDocumentosLogicos([v0, v1]);
    expect(logicos[0]!.vigente.id).toBe("v1");
  });
});

// ── Estado e transições ────────────────────────────────────────────────────

describe("estado do período", () => {
  const docJun = derivarDocumentosLogicos([doc({ tipo: "Balancete", competencia: "2026-06" })]);

  it("sem documento = aberto; com documento = recebido", () => {
    expect(estadoDoPeriodo(null, [])).toBe("aberto");
    expect(estadoDoPeriodo(null, docJun)).toBe("recebido");
  });

  it("fechado é ATO: registro com fechadoEm", () => {
    expect(estadoDoPeriodo(reg({ fechadoEm: new Date("2026-07-15") }), docJun)).toBe("fechado");
  });

  it("reabertura POSTERIOR desfaz o fechamento; refechar depois vale de novo", () => {
    const reaberto = reg({ fechadoEm: new Date("2026-07-15"), reabertoEm: new Date("2026-07-20") });
    expect(estaFechado(reaberto)).toBe(false);
    expect(estadoDoPeriodo(reaberto, docJun)).toBe("recebido");

    const refechado = reg({ fechadoEm: new Date("2026-07-25"), reabertoEm: new Date("2026-07-20") });
    expect(estaFechado(refechado)).toBe(true);
  });

  it("fechar: bloqueado se já fechado; reabrir: exige motivo", () => {
    const fechado = reg({ fechadoEm: new Date("2026-07-15") });
    expect(podeFechar(null).ok).toBe(true);
    expect(podeFechar(fechado).ok).toBe(false);

    expect(podeReabrir(fechado, "retificação do contador").ok).toBe(true);
    expect(podeReabrir(fechado, "").ok).toBe(false);
    expect(podeReabrir(fechado, "   ").ok).toBe(false);
    expect(podeReabrir(null, "motivo").ok).toBe(false); // não está fechado
  });
});

// ── Retificação pós-fechamento ─────────────────────────────────────────────

describe("retificacoesAposFechamento", () => {
  it("versão criada DEPOIS do fechamento aparece; a de antes, não", () => {
    const antes = doc({ id: "antes", tipo: "Balancete", competencia: "2026-06", status: "Substituído", substituidoPorId: "depois", createdAt: new Date("2026-07-10") });
    const depois = doc({ id: "depois", tipo: "Balancete", competencia: "2026-06", createdAt: new Date("2026-07-20") });
    const logicos = derivarDocumentosLogicos([antes, depois]);
    const fechado = reg({ fechadoEm: new Date("2026-07-15") });

    const ret = retificacoesAposFechamento(fechado, logicos);
    expect(ret.map((r) => r.id)).toEqual(["depois"]);
  });

  it("período reaberto não acusa retificação (o ato de fechar foi desfeito)", () => {
    const v = doc({ tipo: "Balancete", competencia: "2026-06", createdAt: new Date("2026-07-20") });
    const reaberto = reg({ fechadoEm: new Date("2026-07-15"), reabertoEm: new Date("2026-07-18") });
    expect(retificacoesAposFechamento(reaberto, derivarDocumentosLogicos([v]))).toEqual([]);
  });

  it("período nunca fechado não acusa nada", () => {
    const v = doc({ tipo: "Balancete", competencia: "2026-06" });
    expect(retificacoesAposFechamento(null, derivarDocumentosLogicos([v]))).toEqual([]);
  });
});

// ── Cadência / faltantes ───────────────────────────────────────────────────

describe("periodosFaltantes", () => {
  const hoje = new Date(2026, 6, 20); // 20/jul/2026 → cobra até jun/2026

  it("acha o buraco no meio da série", () => {
    const docs = derivarDocumentosLogicos([
      doc({ tipo: "Balancete", competencia: "2026-03" }),
      doc({ tipo: "Balancete", competencia: "2026-04" }),
      // 2026-05 faltando
      doc({ tipo: "Balancete", competencia: "2026-06" }),
    ]);
    expect(periodosFaltantes(docs, hoje)).toEqual(["2026-05"]);
  });

  it("cobra os meses até o ANTERIOR ao corrente (o corrente ainda não venceu)", () => {
    const docs = derivarDocumentosLogicos([doc({ tipo: "Balancete", competencia: "2026-04" })]);
    expect(periodosFaltantes(docs, hoje)).toEqual(["2026-05", "2026-06"]);
  });

  it("sem NENHUMA competência válida, não inventa aviso", () => {
    const docs = derivarDocumentosLogicos([doc({ tipo: "DRE" }), doc({ tipo: "Contrato", competencia: "dez/25" })]);
    expect(periodosFaltantes(docs, hoje)).toEqual([]);
  });

  it("BP/DRE anuais com competência NÃO implicam cadência mensal (caso Pampa)", () => {
    // Empresa entrega demonstrações anuais em dez/24, dez/25 e jun/26 —
    // cobrar jan..nov seria alarme falso. Só balancete infere ritmo mensal.
    const docs = derivarDocumentosLogicos([
      doc({ tipo: "BP", competencia: "2024-12" }),
      doc({ tipo: "DRE", competencia: "2024-12" }),
      doc({ tipo: "BP", competencia: "2025-12" }),
      doc({ tipo: "DRE", competencia: "2026-06" }),
    ]);
    expect(periodosFaltantes(docs, hoje)).toEqual([]);
  });

  it("balancete mensal convivendo com anuais: só a série do balancete é cobrada", () => {
    const docs = derivarDocumentosLogicos([
      doc({ tipo: "DRE", competencia: "2024-12" }), // anual — fora da régua
      doc({ tipo: "Balancete", competencia: "2026-04" }),
      doc({ tipo: "Balancete", competencia: "2026-06" }),
    ]);
    expect(periodosFaltantes(docs, hoje)).toEqual(["2026-05"]);
  });

  it("série completa = sem faltantes", () => {
    const docs = derivarDocumentosLogicos([
      doc({ tipo: "Balancete", competencia: "2026-05" }),
      doc({ tipo: "Balancete", competencia: "2026-06" }),
    ]);
    expect(periodosFaltantes(docs, hoje)).toEqual([]);
  });

  it("primeiro documento no mês corrente: nada vencido ainda", () => {
    const docs = derivarDocumentosLogicos([doc({ tipo: "Balancete", competencia: "2026-07" })]);
    expect(periodosFaltantes(docs, hoje)).toEqual([]);
  });
});

// ── Ano fechado / exercício ("YYYY") — pedido do usuário, 20/07/2026 ───────

describe("competência de ANO FECHADO (YYYY)", () => {
  it("DF anual com competência '2025' agrupa por (tipo, ano) — não cai no 'sem competência'", () => {
    const a = doc({ tipo: "DRE", competencia: "2025" });
    const b = doc({ tipo: "DRE", competencia: "2025", createdAt: new Date(2026, 5, 99) });
    const logicos = derivarDocumentosLogicos([a, b]);
    expect(logicos).toHaveLength(1);
    expect(logicos[0].competencia).toBe("2025");
    expect(logicos[0].versoes).toHaveLength(2);
  });

  it("anos diferentes NÃO se fundem ('DRE 2024' ≠ 'DRE 2025')", () => {
    const logicos = derivarDocumentosLogicos([
      doc({ tipo: "DRE", competencia: "2024" }),
      doc({ tipo: "DRE", competencia: "2025" }),
    ]);
    expect(logicos).toHaveLength(2);
  });

  it("balancete ANUAL ('2025') não dispara cadência mensal — mês continua sendo o gatilho", () => {
    const hoje = new Date(2026, 6, 20); // jul/2026
    expect(periodosFaltantes(derivarDocumentosLogicos([doc({ tipo: "Balancete", competencia: "2025" })]), hoje)).toEqual([]);
    // com um balancete MENSAL a cadência volta a valer
    const faltantes = periodosFaltantes(
      derivarDocumentosLogicos([doc({ tipo: "Balancete", competencia: "2026-04" })]),
      hoje
    );
    expect(faltantes).toEqual(["2026-05", "2026-06"]);
  });
});
