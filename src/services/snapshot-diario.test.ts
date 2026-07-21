import { describe, it, expect } from "vitest";
import {
  hashConteudo,
  montarConteudoAnalise,
  aplicarFotoAnalise,
  montarConteudoModelo,
  aplicarFotoModelo,
  CAMPOS_FOTO_ANALISE,
  type DocFoto,
  type BlocoFoto,
  type CenarioFoto,
} from "./snapshot-diario";

const doc = (id: string, extra: Partial<DocFoto> = {}): DocFoto => ({
  id, nome: `doc-${id}.pdf`, tipo: "PDF", competencia: null, moeda: "BRL",
  status: "Processado", confianca: 90, dadosExtraidos: { linhas: [], periodos: [] },
  editadoManualmente: false, versao: 1, hash: `h${id}`, fixadoDeId: null,
  ...extra,
});

const analise = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a1", nome: "IBR Teste", periodo: "2024-2025", status: "Pronta para gerar",
  confianca: 92, resultado: { kpis: { receita: 100 } }, dadosEstruturados: { bp: [], dre: [] },
  ...extra,
});

describe("hashConteudo — base do dedup diário", () => {
  it("mesmo conteúdo → mesmo hash; conteúdo diferente → hash diferente", () => {
    const c1 = montarConteudoAnalise(analise(), [doc("1")]);
    const c2 = montarConteudoAnalise(analise(), [doc("1")]);
    const c3 = montarConteudoAnalise(analise({ confianca: 50 }), [doc("1")]);
    expect(hashConteudo(c1)).toBe(hashConteudo(c2));
    expect(hashConteudo(c1)).not.toBe(hashConteudo(c3));
  });

  it("ordem de fetch dos documentos NÃO muda o hash (sem foto-fantasma diária)", () => {
    const a = montarConteudoAnalise(analise(), [doc("1"), doc("2")]);
    const b = montarConteudoAnalise(analise(), [doc("2"), doc("1")]);
    expect(hashConteudo(a)).toBe(hashConteudo(b));
  });
});

describe("montarConteudoAnalise", () => {
  it("captura exatamente os campos da foto (ausente = null) e nunca a assinatura", () => {
    const c = montarConteudoAnalise(analise({ signature: { por: "x" }, reviewMeta: { r: 1 } }), []);
    for (const campo of CAMPOS_FOTO_ANALISE) expect(campo in c.analysis).toBe(true);
    expect(c.analysis.stcf).toBeNull();
    expect("signature" in c.analysis).toBe(false);
    expect("reviewMeta" in c.analysis).toBe(false);
  });
});

describe("aplicarFotoAnalise — regras de restauração", () => {
  it("devolve os campos da foto e atualiza só documentos que ainda existem", () => {
    const foto = montarConteudoAnalise(analise(), [doc("1", { editadoManualmente: true }), doc("2")]);
    const r = aplicarFotoAnalise(foto, "Erro", [
      { id: "1", nome: "doc-1.pdf" },
      { id: "3", nome: "doc-novo.pdf" },
    ]);
    expect(r.data.confianca).toBe(92);
    expect(r.data.status).toBe("Pronta para gerar");
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0]!.id).toBe("1");
    expect(r.docs[0]!.data.editadoManualmente).toBe(true);
    expect(r.docsIgnorados).toEqual(["doc-2.pdf"]);
    expect(r.docsForaDaFoto).toEqual(["doc-novo.pdf"]);
  });

  it("NUNCA re-conclui: foto 'Concluída' sobre análise reaberta mantém o status atual", () => {
    const foto = montarConteudoAnalise(analise({ status: "Concluída" }), []);
    const r = aplicarFotoAnalise(foto, "Pronta para gerar", []);
    expect(r.data.status).toBe("Pronta para gerar");
  });

  it("status não-conclusivo da foto volta junto com o conteúdo", () => {
    const foto = montarConteudoAnalise(analise({ status: "Rascunho" }), []);
    const r = aplicarFotoAnalise(foto, "Erro", []);
    expect(r.data.status).toBe("Rascunho");
  });
});

const bloco = (id: string, extra: Partial<BlocoFoto> = {}): BlocoFoto => ({
  id, tipo: "receitas", nome: `Bloco ${id}`, ordem: 0, modo: "simples", ativo: true,
  config: { linhasReceita: [] }, ...extra,
});
const cenario = (id: string, extra: Partial<CenarioFoto> = {}): CenarioFoto => ({
  id, nome: `Cenário ${id}`, isBase: false, overrides: {}, ...extra,
});

describe("modelo — montar/aplicar foto", () => {
  const modelo = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "m1", nome: "Valuation 2026", objetivo: "ambos", mesInicial: "2026-01",
    horizonteMeses: 60, visao: "anual", cenarioAtivoId: "c1", realizado: null,
    indicesMacro: { selic: 10 }, status: "Em produção", resultadoCache: { dre: [] },
    ...extra,
  });

  it("ordem de blocos/cenários não muda o hash; resultadoCache fica fora da foto", () => {
    const a = montarConteudoModelo(modelo(), [bloco("b1"), bloco("b2")], [cenario("c1")]);
    const b = montarConteudoModelo(modelo({ resultadoCache: null }), [bloco("b2"), bloco("b1")], [cenario("c1")]);
    expect(hashConteudo(a)).toBe(hashConteudo(b));
  });

  it("restaura configs dos blocos existentes, ignora os excluídos e invalida o cache", () => {
    const foto = montarConteudoModelo(modelo(), [bloco("b1", { config: { x: 1 } }), bloco("b2")], [cenario("c1", { overrides: { n1: { preco: 5 } } })]);
    const r = aplicarFotoModelo(foto, "Em produção", [{ id: "b1" }], [{ id: "c1" }]);
    expect(r.data.resultadoCache).toBeNull();
    expect(r.data.mesInicial).toBe("2026-01");
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.data.config).toEqual({ x: 1 });
    expect(r.scenarios[0]!.data.overrides).toEqual({ n1: { preco: 5 } });
    expect(r.ignorados).toEqual(['bloco "Bloco b2"']);
  });

  it("cenário ativo que não existe mais não vira ponteiro fantasma", () => {
    const foto = montarConteudoModelo(modelo({ cenarioAtivoId: "c-apagado" }), [], []);
    const r = aplicarFotoModelo(foto, "Em produção", [], []);
    expect(r.data.cenarioAtivoId).toBeNull();
  });

  it("NUNCA re-conclui um modelo reaberto", () => {
    const foto = montarConteudoModelo(modelo({ status: "Concluído" }), [], []);
    const r = aplicarFotoModelo(foto, "Em produção", [], []);
    expect(r.data.status).toBe("Em produção");
  });
});
