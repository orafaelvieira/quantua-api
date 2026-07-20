import { describe, it, expect } from "vitest";
import { montarLinhaFixada, type PoolDocMin } from "./fixacao-pool";
import { MATERIAL_TIPO } from "./material-context";

const ANALYSIS = { id: "ibr-1", companyId: "emp-1" };

const poolDoc = (extra: Partial<PoolDocMin> = {}): PoolDocMin => ({
  id: "pool-1",
  nome: "Balancete jun-26.pdf",
  tipo: "Balancete",
  competencia: "2026-06",
  moeda: "BRL",
  storagePath: "uploads/u/pool-emp-1/balancete.pdf",
  hash: "abc123",
  tamanho: "1.2 MB",
  versao: 3,
  dadosExtraidos: null,
  ...extra,
});

describe("montarLinhaFixada", () => {
  it("financeiro: copia metadados, COMPARTILHA o arquivo e nasce Pendente sem dados", () => {
    const linha = montarLinhaFixada(poolDoc(), ANALYSIS);
    expect(linha.analysisId).toBe("ibr-1");
    expect(linha.companyId).toBe("emp-1");
    expect(linha.fixadoDeId).toBe("pool-1");
    expect(linha.tipo).toBe("Balancete");
    expect(linha.competencia).toBe("2026-06");
    // fonte única de arquivo: mesmo storagePath e hash do pool (guardado UMA vez)
    expect(linha.storagePath).toBe("uploads/u/pool-emp-1/balancete.pdf");
    expect(linha.hash).toBe("abc123");
    expect(linha.status).toBe("Pendente");
    expect(linha.dadosExtraidos).toBeUndefined();
  });

  it("versão do pool é ESPELHADA — é o selo de proveniência 'usa v3'", () => {
    expect(montarLinhaFixada(poolDoc({ versao: 3 }), ANALYSIS).versao).toBe(3);
    expect(montarLinhaFixada(poolDoc({ versao: 1 }), ANALYSIS).versao).toBe(1);
  });

  it("material COM resumo cacheado: herda o cache e nasce Processado (paga-se 1× por versão)", () => {
    const cache = { resumo: "Deck institucional da empresa…", custo: { total: 0.01 } };
    const linha = montarLinhaFixada(poolDoc({ tipo: MATERIAL_TIPO, dadosExtraidos: cache }), ANALYSIS);
    expect(linha.status).toBe("Processado");
    expect(linha.dadosExtraidos).toEqual(cache);
  });

  it("material SEM resumo: nasce Pendente — será resumido no primeiro uso", () => {
    const linha = montarLinhaFixada(poolDoc({ tipo: MATERIAL_TIPO, dadosExtraidos: null }), ANALYSIS);
    expect(linha.status).toBe("Pendente");
    expect(linha.dadosExtraidos).toBeUndefined();
  });

  it("material com dadosExtraidos SEM campo resumo (ex.: erro de extração) NÃO herda", () => {
    const linha = montarLinhaFixada(
      poolDoc({ tipo: MATERIAL_TIPO, dadosExtraidos: { erro: "sem texto" } }),
      ANALYSIS,
    );
    expect(linha.status).toBe("Pendente");
    expect(linha.dadosExtraidos).toBeUndefined();
  });

  it("financeiro com dadosExtraidos no pool NÃO herda extração — cada IBR extrai a sua fotografia", () => {
    const linha = montarLinhaFixada(
      poolDoc({ dadosExtraidos: { linhas: [], periodos: ["2026-06"] } }),
      ANALYSIS,
    );
    expect(linha.status).toBe("Pendente");
    expect(linha.dadosExtraidos).toBeUndefined();
  });
});
