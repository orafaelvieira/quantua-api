import { vi, describe, it, expect, beforeEach } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: createMock } } }));
vi.mock("../config/env", () => ({ env: { anthropicApiKey: "test-key" } }));

import { sugerirClassificacoesIA, chaveNM, opcoesDREPermitidas } from "./classification-suggest";
import type { NaoMapeado } from "./ai-extraction";

const reply = (payload: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  usage: { input_tokens: 1000, output_tokens: 300 },
});

beforeEach(() => createMock.mockReset());

describe("sugerirClassificacoesIA", () => {
  const nms: NaoMapeado[] = [
    { nome: "Impostos Estaduais", grupo: "DRE > DESPESAS TRIBUTARIAS", destino: "Outras Despesas Operacionais", valor: -274225, periodo: "2020", tipo: "DRE" },
    { nome: "Conta Estranha", grupo: "Passivo Circulante", destino: "Outros Passivos Circulantes", valor: 100, periodo: "2020", tipo: "BP" },
  ];
  const dreInputs = ["Receita Bruta", "Deduções da Receita Bruta", "Impostos s/ Faturamento", "Custo Operacional", "Despesas Gerais e Administrativas", "Outras Despesas Operacionais"];

  it("aceita sugestão válida (dentro das opções) e monta a chave tipo|nome", async () => {
    createMock.mockResolvedValue(reply([
      { i: 1, sugestao: "Impostos s/ Faturamento", justificativa: "Tributo estadual proporcional à receita.", confianca: "media", verificar: "Confirmar no razão se é ICMS sobre vendas." },
    ]));
    const r = await sugerirClassificacoesIA(nms, { setor: "Bebidas", receitaUltimoAno: 5389571 }, dreInputs);
    const s = r.sugestoes[chaveNM(nms[0])];
    expect(s?.sugestao).toBe("Impostos s/ Faturamento");
    expect(s?.confianca).toBe("media");
    expect(s?.verificar).toContain("razão");
    expect(r.custo?.usd).toBeGreaterThan(0);
  });

  it("DESCARTA sugestão fora das opções permitidas (blindagem)", async () => {
    createMock.mockResolvedValue(reply([
      { i: 1, sugestao: "EBITDA", justificativa: "inventada", confianca: "alta" }, // subtotal — não é opção
      { i: 2, sugestao: "Empréstimos e Financiamentos - CP", justificativa: "ok", confianca: "alta" }, // BP: dentro do grupo PC ✓
    ]));
    const r = await sugerirClassificacoesIA(nms, {}, dreInputs);
    expect(r.sugestoes[chaveNM(nms[0])]).toBeUndefined(); // EBITDA barrado
    expect(r.sugestoes[chaveNM(nms[1])]?.sugestao).toBe("Empréstimos e Financiamentos - CP");
  });

  it("é best-effort: resposta inválida/não-JSON da IA retorna vazio sem quebrar", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "não consegui ajudar com isso" }], usage: { input_tokens: 50, output_tokens: 10 } });
    const r = await sugerirClassificacoesIA(nms, {}, dreInputs);
    expect(r.sugestoes).toEqual({});
  });

  it("lote vazio não chama a IA (custo zero)", async () => {
    const r = await sugerirClassificacoesIA([], {}, dreInputs);
    expect(createMock).not.toHaveBeenCalled();
    expect(r.custo).toBeNull();
  });
});

describe("opcoesDREPermitidas — a posição no documento manda também na SUGESTÃO", () => {
  // Pessoas pode ser CUSTO (mão de obra fabril) ou DESPESA (folha administrativa),
  // conforme onde a empresa declara a conta na DRE original.
  const inputs = [
    "Custo Operacional",
    "Despesas Gerais e Administrativas",
    "Despesas com Pessoas", // conta custom do modelo (caso Move Farma)
    "Outras Despesas Operacionais",
    "Depreciação e Amortização", // neutra — passa nos dois blocos
    "Receitas Financeiras",
  ];

  it("conta no bloco de DESPESAS: oferece despesas + neutras, NUNCA Custo Operacional", () => {
    const ops = opcoesDREPermitidas(inputs, -47184, "DRE > DESPESAS OPERACIONAIS > DESPESAS COM PESSOAL");
    expect(ops).toContain("Despesas com Pessoas");
    expect(ops).toContain("Depreciação e Amortização");
    expect(ops).not.toContain("Custo Operacional");
  });

  it("conta no bloco de CUSTOS: oferece Custo Operacional + neutras, NUNCA linhas de despesa", () => {
    const ops = opcoesDREPermitidas(inputs, -47184, "DRE > CUSTOS DOS PRODUTOS VENDIDOS > MAO DE OBRA");
    expect(ops).toContain("Custo Operacional");
    expect(ops).toContain("Depreciação e Amortização");
    expect(ops).not.toContain("Despesas com Pessoas");
    expect(ops).not.toContain("Despesas Gerais e Administrativas");
  });

  it("caminho sem bloco declarado: só o filtro de natureza (tudo de saída)", () => {
    const ops = opcoesDREPermitidas(inputs, -100, "DRE");
    expect(ops).toContain("Custo Operacional");
    expect(ops).toContain("Despesas com Pessoas");
    expect(ops).not.toContain("Receitas Financeiras"); // entrada, sinal oposto
  });
});
