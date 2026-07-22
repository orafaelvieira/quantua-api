import { describe, it, expect } from "vitest";
import {
  B3_SUBSETOR_PARA_DAMODARAN,
  B3_SETOR_PARA_DAMODARAN,
  DAMODARAN_PT,
  DAMODARAN_PADRAO,
  damodaranDoSetorB3,
  rotuloDamodaran,
} from "./damodaran-b3";
import { BETAS_EMERGING } from "./wacc-referencias";
import seedB3 from "../../prisma/seed-data/b3-sectors-seed.json";

const BETAS = new Set(BETAS_EMERGING.map((b) => b.setor));

/* O DEFEITO QUE ESTES TESTES TRAVAM: o de-para antigo apontava para
 * "Healthcare Facilities" e "Retail (Online)", que NÃO existem na tabela de
 * betas. O lookup casava, gravava o setor, e o `find` do beta devolvia
 * undefined → beta 1,00 em silêncio. Um destino inexistente nunca mais passa. */
describe("de-para B3 → Damodaran: todo destino existe na tabela de betas", () => {
  it("todo subsetor aponta para uma indústria que tem beta", () => {
    for (const [code, industria] of Object.entries(B3_SUBSETOR_PARA_DAMODARAN)) {
      expect(BETAS.has(industria), `${code} → "${industria}" não existe em BETAS_EMERGING`).toBe(true);
    }
  });

  it("todo setor-pai aponta para uma indústria que tem beta", () => {
    for (const [code, industria] of Object.entries(B3_SETOR_PARA_DAMODARAN)) {
      expect(BETAS.has(industria), `${code} → "${industria}" não existe em BETAS_EMERGING`).toBe(true);
    }
  });

  it("o padrão da cascata existe", () => {
    expect(BETAS.has(DAMODARAN_PADRAO)).toBe(true);
  });
});

/* COBERTURA: a taxonomia B3 real é a fonte da verdade. Se a B3 ganhar um
 * subsetor novo e ninguém mapear, este teste acusa — em vez de o modelo nascer
 * com beta genérico sem ninguém perceber. */
describe("cobertura da taxonomia B3 em uso", () => {
  const subsetores = (seedB3 as { subsectors: Array<{ code: string }> }).subsectors;
  const setores = (seedB3 as { sectors: Array<{ code: string }> }).sectors;

  it("os 44 subsetores da B3 estão todos mapeados", () => {
    const faltando = subsetores.map((s) => s.code).filter((c) => !B3_SUBSETOR_PARA_DAMODARAN[c]);
    expect(faltando, `subsetores sem de-para: ${faltando.join(", ")}`).toEqual([]);
    expect(subsetores.length).toBe(44);
  });

  it("os 11 setores-pai da B3 estão todos mapeados", () => {
    const faltando = setores.map((s) => s.code).filter((c) => !B3_SETOR_PARA_DAMODARAN[c]);
    expect(faltando, `setores sem de-para: ${faltando.join(", ")}`).toEqual([]);
    expect(setores.length).toBe(11);
  });

  it("o mapa não tem código que a B3 não conhece (evita de-para órfão)", () => {
    const codigosB3 = new Set(subsetores.map((s) => s.code));
    const orfaos = Object.keys(B3_SUBSETOR_PARA_DAMODARAN).filter((c) => !codigosB3.has(c));
    expect(orfaos, `códigos fora da taxonomia: ${orfaos.join(", ")}`).toEqual([]);
  });
});

describe("damodaranDoSetorB3 — cascata", () => {
  it("subsetor conhecido resolve direto", () => {
    // Caso real: o IBR da Move Farma grava este código.
    expect(damodaranDoSetorB3("saude__medicamentos_e_outros_produtos")).toEqual({
      industria: "Drugs (Pharmaceutical)", origem: "subsetor",
    });
  });

  it("subsetor DESCONHECIDO sobe para o setor-pai (B3 pode criar subsetor novo)", () => {
    expect(damodaranDoSetorB3("saude__subsetor_que_ainda_nao_existe")).toEqual({
      industria: "Healthcare Products", origem: "setor",
    });
  });

  it("setor-pai sozinho (sem subsetor) resolve", () => {
    expect(damodaranDoSetorB3("tecnologia_da_informacao")).toEqual({
      industria: "Software (System & Application)", origem: "setor",
    });
  });

  it("vazio, nulo ou setor fora da taxonomia cai no mercado total — nunca fica sem beta", () => {
    for (const entrada of [null, undefined, "", "   ", "setor_inventado"]) {
      expect(damodaranDoSetorB3(entrada).industria).toBe(DAMODARAN_PADRAO);
      expect(damodaranDoSetorB3(entrada).origem).toBe("padrao");
    }
  });

  it("o setor legado (pré-B3) não quebra: cai no padrão em vez de estourar", () => {
    expect(damodaranDoSetorB3("industria_textil").industria).toBe(DAMODARAN_PADRAO);
  });
});

describe("tradução para português", () => {
  it("toda indústria da tabela de betas tem nome em português", () => {
    const semPt = BETAS_EMERGING.map((b) => b.setor).filter((s) => !DAMODARAN_PT[s]);
    expect(semPt, `sem tradução: ${semPt.join(", ")}`).toEqual([]);
  });

  it("não há tradução órfã (nome que não existe mais na tabela de betas)", () => {
    const orfas = Object.keys(DAMODARAN_PT).filter((s) => !BETAS.has(s));
    expect(orfas, `traduções órfãs: ${orfas.join(", ")}`).toEqual([]);
  });

  it("o rótulo mostra o português e preserva o inglês (chave da fonte)", () => {
    expect(rotuloDamodaran("Drugs (Pharmaceutical)")).toBe("Medicamentos (farmacêutica) (Drugs (Pharmaceutical))");
  });

  it("indústria sem tradução cai no próprio nome, sem quebrar a tela", () => {
    expect(rotuloDamodaran("Industria Nova")).toBe("Industria Nova");
  });
});
