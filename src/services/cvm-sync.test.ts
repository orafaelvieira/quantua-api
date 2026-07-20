import { describe, it, expect } from "vitest";
import { modoDoSnapshot, filaDeAvisos, checkpointAplicavel, type ProgressoHistorico, type CheckpointRecalculo } from "./cvm-sync";

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

/**
 * A fila de pendentes roda os arquivos SEM clique por arquivo — e a ordem não é
 * cosmética: o 4T e o LTM de um ano são derivados com o DFP do ano anterior já na
 * base. Processar na ordem em que os avisos chegaram produziria LTM nulo que
 * ninguém recalcularia depois.
 */
const HOJE = new Date("2026-07-19T00:00:00Z");
const chave = (arq: string, v = "v1") => `cvm:${arq}:${v}`;

describe("filaDeAvisos", () => {
  it("ordena pelo plano, não pela chegada do aviso", () => {
    // caso real do usuário, avisos fora de ordem
    const chaves = [chave("itr_2024"), chave("dfp_2023"), chave("itr_2023"), chave("dfp_2022"), chave("itr_2022")];
    expect(filaDeAvisos(chaves, HOJE).map((f) => f.arquivo))
      .toEqual(["itr_2022", "dfp_2022", "itr_2023", "dfp_2023", "itr_2024"]);
  });

  it("dedup: várias versões do mesmo arquivo viram um trabalho só", () => {
    const chaves = [chave("dfp_2023", "etag-a"), chave("dfp_2023", "etag-b"), chave("itr_2023")];
    expect(filaDeAvisos(chaves, HOJE).map((f) => f.arquivo)).toEqual(["itr_2023", "dfp_2023"]);
  });

  it("devolve tipo e ano prontos para o pipeline", () => {
    expect(filaDeAvisos([chave("dfp_2022")], HOJE)).toEqual([{ tipo: "dfp", ano: 2022, arquivo: "dfp_2022" }]);
  });

  it("ignora chave malformada em vez de quebrar a fila inteira", () => {
    const chaves = [null, "", "cvm:", "cvm:lixo:v1", "cvm:dfp_abcd:v1", chave("itr_2023")];
    expect(filaDeAvisos(chaves, HOJE).map((f) => f.arquivo)).toEqual(["itr_2023"]);
  });

  it("arquivo fora do plano vai para o fim, sem desordenar os demais", () => {
    const chaves = [chave("dfp_2099"), chave("dfp_2023"), chave("itr_2022")];
    expect(filaDeAvisos(chaves, HOJE).map((f) => f.arquivo)).toEqual(["itr_2022", "dfp_2023", "dfp_2099"]);
  });
});

/**
 * REGRESSÃO DE UM BUG CRÍTICO (v139): o checkpoint era gravado ANTES do DELETE do
 * range de indicadores. Morte durante o DELETE fazia rollback dele e deixava o
 * checkpoint de pé; a retomada via os indicadores VELHOS, concluía "está tudo
 * pronto" e carimbava o arquivo como sincronizado com o etag NOVO — dados da versão
 * anterior marcados como atuais, sem erro e sem nova detecção possível (o etag
 * gravado passava a bater com o publicado pela CVM).
 *
 * A marca `rangeLimpo` é a prova de que o DELETE commitou. Sem ela, o checkpoint NÃO
 * pode ser aplicado — refazer o arquivo inteiro é o lado seguro de errar.
 */
const cp = (extra: Partial<CheckpointRecalculo> = {}): CheckpointRecalculo => ({
  arquivo: "dfp_2024", dtFims: ["2024-12-31"], etag: "novo", lastModified: null,
  empresas: 683, periodos: 683, ...extra,
});

describe("checkpointAplicavel", () => {
  it("aceita só com a prova de que o range foi apagado", () => {
    expect(checkpointAplicavel(cp({ rangeLimpo: true }))).toBe(true);
  });

  it("recusa checkpoint do v139 (sem a marca) — evitaria dado velho carimbado como novo", () => {
    expect(checkpointAplicavel(cp())).toBe(false);
  });

  it("recusa ausência de checkpoint", () => {
    expect(checkpointAplicavel(null)).toBe(false);
    expect(checkpointAplicavel(undefined)).toBe(false);
  });
});
