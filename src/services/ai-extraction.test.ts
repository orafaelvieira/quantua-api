import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock do SDK da Anthropic: client.messages.create é controlado pelo teste.
// vi.hoisted porque vi.mock é içado acima dos imports/consts.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));
// env importa process.env no load — fornecemos uma chave fake.
vi.mock("../config/env", () => ({ env: { anthropicApiKey: "test-key" } }));

import { extractFinancialsWithAI } from "./ai-extraction";
import { DEFAULT_BP_MODEL } from "./account-mapper";

const aiReply = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

// BP mínimo, fechado (Ativo = -Passivo na convenção do parser), com a IA devolvendo
// DELIBERADAMENTE o ANO ERRADO ("2099") na chave — o pin do doc deve sobrescrever.
const bpComAnoErrado = (ac: number) =>
  aiReply({
    "2099": {
      grupos: {
        "Ativo Circulante": [{ nome: "Caixa e Equivalentes", valor: ac }],
        "Passivo Circulante": [{ nome: "Fornecedores", valor: -ac }],
      },
      totais: { "Ativo Total": ac, "Passivo Total": ac },
    },
  });

beforeEach(() => createMock.mockReset());

describe("extractFinancialsWithAI — período por-documento (pin)", () => {
  it("fixa cada doc no SEU período conhecido mesmo quando a IA devolve o ano errado", async () => {
    // Dois docs de BP, cada um com 1 período conhecido pelo parser (2021 e 2022).
    // A IA devolve "2099" para AMBOS — sem o pin, colidiriam e um ano sumiria.
    createMock.mockImplementation((args: any) => {
      const text: string = args?.messages?.[0]?.content?.map((c: any) => c.text ?? "").join("") ?? "";
      if (text.includes("MARCADOR_DOC_A")) return Promise.resolve(bpComAnoErrado(100));
      if (text.includes("MARCADOR_DOC_B")) return Promise.resolve(bpComAnoErrado(200));
      return Promise.resolve(aiReply({}));
    });

    const docs = [
      { raw: "MARCADOR_DOC_A\nCaixa = 100", tipo: "Balanço", periodos: ["2021"] },
      { raw: "MARCADOR_DOC_B\nCaixa = 200", tipo: "Balanço", periodos: ["2022"] },
    ];
    const r = await extractFinancialsWithAI(docs, []);

    // Os dois anos sobrevivem, e NÃO há "2099" (palpite da IA foi ignorado).
    expect(Object.keys(r.arvoreOriginalBP).sort()).toEqual(["2021", "2022"]);
    expect(r.periodos.sort()).toEqual(["2021", "2022"]);
    expect(r.arvoreOriginalBP["2099"]).toBeUndefined();

    // Os valores caíram no ano certo (não trocados, não somados em dobro).
    const acDe = (p: string) =>
      (r.arvoreOriginalBP[p].grupos["Ativo Circulante"] ?? []).reduce((s, i) => s + i.valor, 0);
    expect(acDe("2021")).toBe(100);
    expect(acDe("2022")).toBe(200);
  });

  it("sem doc.periodos, cai no comportamento antigo (canonicaliza o que a IA devolve)", async () => {
    // Garante que não quebramos o caminho legado (visão/PDF sem período conhecido).
    createMock.mockResolvedValue(bpComAnoErrado(50));
    const r = await extractFinancialsWithAI([{ raw: "x", tipo: "Balanço" }], []);
    expect(Object.keys(r.arvoreOriginalBP)).toEqual(["2099"]); // segue o ano devolvido pela IA
  });
});

describe("extractFinancialsWithAI — árvore por INDENTAÇÃO (rawIndent) pula o LLM", () => {
  // Regressão do caso real: a rota alimenta `raw` = linhasToText (contexto>conta, SEM
  // indentação e já colapsado no nível do parser) e `rawIndent` = doc.raw (INDENTADO). O
  // builder determinístico DEVE ler o rawIndent — se ler o raw (colapsado), não vê hierarquia,
  // cai no LLM e as folhas Grau-4 somem. Este teste garante a fiação certa.
  const P = "31/12/2020";
  // BP "Grau 4": Passivo Circulante > EXIGÍVEL A CURTO PRAZO (wrapper) > 3 folhas. Fecha.
  const RAW_INDENT = [
    "   ATIVO                                 1.000.000,00",
    "    ATIVO CIRCULANTE                        400.000,00",
    "      DISPONIBILIDADES                      400.000,00",
    "       CAIXA                                400.000,00",
    "    ATIVO NAO CIRCULANTE                     600.000,00",
    "      ATIVO IMOBILIZADO                      600.000,00",
    "       BENS EM OPERACAO                      600.000,00",
    "   PASSIVO                                1.000.000,00",
    "    PASSIVO CIRCULANTE                       600.000,00",
    "      EXIGIVEL A CURTO PRAZO                 600.000,00",
    "       FORNECEDORES A PAGAR                  250.000,00",
    "       OBRIGACOES TRABALHISTAS A PAGAR       150.000,00",
    "       EMPREST FINANC C.PRAZO                200.000,00",
    "    PATRIMONIO LIQUIDO                        400.000,00",
    "      CAPITAL SOCIAL REALIZADO                400.000,00",
    "       CAPITAL SOCIAL                         400.000,00",
  ].join("\n");
  // `raw` colapsado (o que linhasToText produz) — SEM indentação: sozinho, o builder daria null.
  const RAW_COLAPSADO = [
    `ATIVO = {"${P}":1000000}`,
    `ATIVO > ATIVO CIRCULANTE > DISPONIBILIDADES = {"${P}":400000}`,
    `PASSIVO > PASSIVO CIRCULANTE > EXIGIVEL A CURTO PRAZO = {"${P}":600000}`,
    `PASSIVO > PATRIMONIO LIQUIDO > CAPITAL SOCIAL REALIZADO = {"${P}":400000}`,
  ].join("\n");

  it("lê rawIndent, PULA o LLM (custo 0) e recupera as folhas Grau-4 na linha certa", async () => {
    createMock.mockResolvedValue(aiReply({})); // se o LLM for chamado, devolve vazio → asserts falham
    const docs = [{ raw: RAW_COLAPSADO, rawIndent: RAW_INDENT, tipo: "Balanço", periodos: [P] }];
    const r = await extractFinancialsWithAI(docs, [], undefined, DEFAULT_BP_MODEL, {});

    // O LLM NÃO foi acionado — a árvore determinística cobriu o BP inteiro.
    expect(createMock).not.toHaveBeenCalled();
    expect(r.custo.usd).toBe(0);

    // As 3 folhas do PC caíram na linha CERTA do modelo (não colapsadas em "Outros").
    const val = (c: string) => r.bp.find((l) => l.conta === c)?.valores[P] ?? 0;
    expect(val("Fornecedores - CP")).toBeCloseTo(250000, 2);
    expect(val("Obrigações Trabalhistas - CP")).toBeCloseTo(150000, 2);
    expect(val("Empréstimos e Financiamentos - CP")).toBeCloseTo(200000, 2);
    expect(val("Passivo Circulante")).toBeCloseTo(600000, 2);
  });
});
