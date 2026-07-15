import { describe, it, expect } from "vitest";
import { mapAccountToBPGroup, mapAccountToDRE, normalizeDRESigns } from "./account-mapper";

// Regressões do caso AOCP (visualizador SPED, 2026-07-14).

describe("tradução CP↔LP — a posição no documento manda", () => {
  const clientes = [{ nomeOriginal: "Clientes Diversos", contaDestino: "Contas a Receber - CP", grupoConta: "Ativo Circulante" }];

  it("entrada CP + conta no Ativo NÃO Circulante → linha-gêmea LP", () => {
    expect(mapAccountToBPGroup("CLIENTES DIVERSOS", "ANC", clientes)).toBe("Contas a Receber - LP");
  });

  it("no grupo da entrada, destino original preservado", () => {
    expect(mapAccountToBPGroup("CLIENTES DIVERSOS", "AC", clientes)).toBe("Contas a Receber - CP");
  });

  it("gêmeo de outro LADO (Ativo×Passivo) continua proibido", () => {
    const forn = [{ nomeOriginal: "Fornecedores Diversos", contaDestino: "Fornecedores - CP", grupoConta: "Passivo Circulante" }];
    // conta de PASSIVO num grupo de ATIVO: nem o original nem o gêmeo servem
    expect(mapAccountToBPGroup("FORNECEDORES DIVERSOS", "AC", forn)).toBeNull();
  });
});

describe("normalização — abreviações contábeis P/, S/, C/", () => {
  it("PROVISÃO P/ IRPJ casa a entrada 'Provisão para IRPJ e CSLL'", () => {
    const dict = [{ nomeOriginal: "Provisão para IRPJ e CSLL", contaDestino: "Obrigações Tributárias - CP", grupoConta: "Passivo Circulante" }];
    expect(mapAccountToBPGroup("PROVISÃO P/ IRPJ E CSLL", "PC", dict)).toBe("Obrigações Tributárias - CP");
  });

  it("ENCARGOS S/ PARCELAMENTOS casa a entrada 'Encargos sobre Parcelamentos'", () => {
    const dict = [{ nomeOriginal: "Encargos sobre Parcelamentos", contaDestino: "Obrigações Tributárias - LP", grupoConta: "Passivo Não Circulante" }];
    expect(mapAccountToBPGroup("(-) (-) ENCARGOS S/ PARCELAMENTOS", "PNC", dict)).toBe("Obrigações Tributárias - LP");
  });

  it("abreviação sem espaço também expande (P/CONTR.)", () => {
    const dict = [{ nomeOriginal: "Provisão para Contr. Social", contaDestino: "IR e CSLL", grupoConta: "IR e CSLL" }];
    expect(mapAccountToDRE("(-) PROVISÃO P/CONTR. SOCIAL", dict)).toBe("IR e CSLL");
  });
});

describe("fuzzy — conectivos não pontuam (stopwords)", () => {
  it("'DESPESAS C/ADMINISTRAÇÃO' NUNCA casa 'Despesas com P&D' pelo {despesas, com}", () => {
    // Sem dicionário: o fuzzy não pode inventar P&D só porque "com" sobrepõe.
    expect(mapAccountToDRE("DESPESAS C/ADMINISTRAÇÃO")).not.toBe("Despesas com P&D");
  });
});

describe("nome genérico de UMA palavra não casa linha específica", () => {
  // Caso AOCP em produção: a folha "DESPESAS" (sob "Outras Despesas Operacionais")
  // casava por contains a PRIMEIRA linha do modelo contendo a palavra — no modelo do
  // usuário, "Despesas com Pessoas". Nome de 1 palavra genérica → null; o fold decide
  // pelo contexto do pai (posição no documento).
  it("DESPESAS / RECEITAS soltos → null (sem dicionário)", () => {
    expect(mapAccountToDRE("DESPESAS")).toBeNull();
    expect(mapAccountToDRE("(-) DESPESAS")).toBeNull();
    expect(mapAccountToDRE("RECEITAS")).toBeNull();
  });
  it("entrada DELIBERADA de dicionário para o nome genérico continua valendo", () => {
    const dict = [{ nomeOriginal: "Despesas", contaDestino: "Outras Despesas Operacionais", grupoConta: "Outras Despesas Operacionais" }];
    expect(mapAccountToDRE("DESPESAS", dict)).toBe("Outras Despesas Operacionais");
  });
  it("com o contexto do pai concatenado, resolve na linha do pai", () => {
    expect(mapAccountToDRE("Outras Despesas Operacionais DESPESAS")).toBe("Outras Despesas Operacionais");
  });
});

describe("normalizeDRESigns — receita negativa é informação, não erro (caso AOCP 2023)", () => {
  const linha = (conta: string, v: number, subtotal = false) =>
    ({ conta, valores: { "31/12/2023": v }, subtotal, editado: false } as any);
  const P = ["31/12/2023"];
  const val = (dre: any[], c: string) => dre.find((l: any) => l.conta === c).valores["31/12/2023"];

  it("estorno: receita NÃO operacional negativa com Receita Bruta positiva → sinal PRESERVADO", () => {
    // Doc AOCP 2023: "(-) RESULTADOS NÃO-OPERACIONAIS R$ (140.908,48)" — forçar o
    // positivo dobrava o erro no LL (calculado 4.277.329 vs declarado 3.995.512).
    const dre = [linha("Receita Bruta", 7354504), linha("Outras Receitas Não Operacionais", -140908.48)];
    normalizeDRESigns(dre, P);
    expect(val(dre, "Outras Receitas Não Operacionais")).toBeCloseTo(-140908.48, 2);
  });

  it("convenção CRÉDITO-NEGATIVO (Receita Bruta < 0): receitas viram positivas como antes", () => {
    const dre = [linha("Receita Bruta", -1000), linha("Receitas Financeiras", -27.5)];
    normalizeDRESigns(dre, P);
    expect(val(dre, "Receita Bruta")).toBe(1000);
    expect(val(dre, "Receitas Financeiras")).toBe(27.5);
  });

  it("sem Receita Bruta no período: soma das receitas negativa decide a convenção", () => {
    const dre = [linha("Receitas Financeiras", -500), linha("Outras Receitas Operacionais", -30)];
    normalizeDRESigns(dre, P);
    expect(val(dre, "Receitas Financeiras")).toBe(500);
  });

  it("redutoras continuam forçadas ao negativo (docs que imprimem despesa positiva)", () => {
    const dre = [linha("Receita Bruta", 1000), linha("Despesas Financeiras", 457123.28)];
    normalizeDRESigns(dre, P);
    expect(val(dre, "Despesas Financeiras")).toBeCloseTo(-457123.28, 2);
  });
});
