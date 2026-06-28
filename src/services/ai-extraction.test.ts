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
