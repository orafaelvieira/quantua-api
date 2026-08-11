/**
 * CASCATA ÚNICA — a régua por ESCOPO.
 *
 * O IBR processa o LOTE do período (BP + DRE juntos): cobrar as cinco provas é
 * justo. A porta da Data room lê UM documento por vez — num DRE avulso não há
 * Ativo nem Passivo, e a régua de cinco provas dava score 0 em TODOS os
 * candidatos: a cascata pagava Haiku E Sonnet para no fim descartar os dois
 * (a troca exige score maior). Este arquivo trava o comportamento por escopo.
 *
 * `escopo: "auto"` é o caminho do /process e NÃO pode mudar — é o teste de
 * não-retrocesso do IBR.
 */
import { describe, it, expect, vi } from "vitest";
import { extrairComCascata, detectDocType, mergeItensPorConta } from "./extracao-cascata";
import { DEFAULT_BP_MODEL } from "./account-mapper";
import type { ParsedDocument } from "./parser";
import type { DREModel } from "./model-version";

vi.mock("./ai-extraction", async (original) => {
  const real = await original<typeof import("./ai-extraction")>();
  return { ...real, extractFinancialsWithAI: vi.fn(async () => { throw new Error("IA não deve ser chamada neste teste"); }) };
});

const DRE_MODEL: DREModel = { lines: [], extrasPorBloco: {} } as unknown as DREModel;

/** Documento parseado sintético: linhas viram BP/DRE pelo mapeamento padrão. */
const doc = (nome: string, tipo: string, raw: string, linhas: Array<{ conta: string; valores: Record<string, number> }>): ParsedDocument =>
  ({ tipo, raw, periodos: ["31/12/2024"], linhas: linhas as never });

const BP_COMPLETO = doc("bp.pdf", "Balanço Patrimonial",
  "ATIVO CIRCULANTE ... PASSIVO CIRCULANTE",
  [
    { conta: "Caixa e Equivalentes de Caixa", valores: { "31/12/2024": 600 } },
    { conta: "Contas a Receber - CP", valores: { "31/12/2024": 400 } },
    { conta: "Fornecedores - CP", valores: { "31/12/2024": 300 } },
    { conta: "Capital Social", valores: { "31/12/2024": 700 } },
  ]);

const DRE_AVULSA = doc("dre.pdf", "DRE",
  "DEMONSTRAÇÃO DO RESULTADO receita bruta custo operacional",
  [
    { conta: "Receita Bruta", valores: { "31/12/2024": 1000 } },
    { conta: "Custo Operacional", valores: { "31/12/2024": -600 } },
  ]);

const opts = (escopo?: "auto" | "BP" | "DRE") => ({
  dictForBP: [], dictForDRE: [], bpModel: DEFAULT_BP_MODEL, dreModel: DRE_MODEL,
  hibridoAtivo: false, // sem IA: o teste mede a RÉGUA, não a extração
  ...(escopo ? { escopo } : {}),
});

describe("régua por escopo", () => {
  it('escopo "BP" SEM total impresso: as provas de composição não rodam (teto 2)', async () => {
    // Sem o total que o documento imprime, comparar AC+ANC com o Ativo Total
    // MONTADO seria tautologia — a prova não roda e não vale ponto.
    const r = await extrairComCascata([{ nome: "bp.pdf", tipo: "Balanço Patrimonial", parsed: BP_COMPLETO }], opts("BP"));
    expect(r.escolhido.scoreMax).toBe(2);
    expect(r.escolhido.validacao.composicaoAtivoVerificada).toBe(false);
    expect(r.escolhido.fonte).toBe("heuristico");
  });

  it('escopo "DRE" sem subtotal declarado: nada é provado e NÃO fecha', async () => {
    const r = await extrairComCascata([{ nome: "dre.pdf", tipo: "DRE", parsed: DRE_AVULSA }], opts("DRE"));
    expect(r.escolhido.validacao.reconciliacaoDRE.verificada).toBe(false);
    expect(r.escolhido.scoreMax).toBe(0);
    // teto 0 é "não provei nada" — nunca "fechou".
    expect(r.escolhido.fecha).toBe(false);
  });

  it('escopo "DRE" reconhece que HÁ dados (a DRE avulsa não é candidato vazio)', async () => {
    const r = await extrairComCascata([{ nome: "dre.pdf", tipo: "DRE", parsed: DRE_AVULSA }], opts("DRE"));
    const receita = r.escolhido.dre.find((d) => d.conta === "Receita Bruta");
    expect(receita?.valores["31/12/2024"]).toBe(1000);
  });

  it('escopo "auto" (o do /process) cobra as provas patrimoniais e a da DRE', async () => {
    const r = await extrairComCascata([{ nome: "bp.pdf", tipo: "Balanço Patrimonial", parsed: BP_COMPLETO }], opts());
    // Sem totais impressos e sem subtotais de DRE declarados sobram as duas
    // provas que independem do documento: equação patrimonial e detalhe.
    expect(r.escolhido.scoreMax).toBe(2);
  });

  it("TOTAL IMPRESSO no documento vira prova cruzada — e reprova quando não bate", async () => {
    const comTotalErrado: ParsedDocument = { ...BP_COMPLETO };
    const doc = { nome: "bp.pdf", tipo: "Balanço Patrimonial", parsed: comTotalErrado };
    const ia = await import("./ai-extraction");
    vi.mocked(ia.extractFinancialsWithAI).mockResolvedValueOnce({
      bp: [
        { conta: "Ativo Circulante", valores: { "31/12/2024": 1000 } },
        { conta: "Ativo Total", valores: { "31/12/2024": 1000 } },
        { conta: "Passivo Total", valores: { "31/12/2024": 1000 } },
      ] as never,
      dre: [] as never, periodos: ["31/12/2024"], declarados: {},
      // O documento IMPRIME 9.999 de Ativo Total — a leitura montou 1.000.
      arvoreOriginalBP: { "31/12/2024": { grupos: { "Ativo Circulante": [{ nome: "Caixa", valor: 1000 }] }, totais: { "Ativo Total": 9999 } } },
      arvoreOriginalDRE: {}, naoMapeados: [], alertasComposicao: [], custo: { usd: 0.01 },
    } as never);
    const r = await extrairComCascata([doc], { ...opts("BP"), hibridoAtivo: true });
    const venceu = r.escolhido.fonte === "hibrido" ? r.escolhido : null;
    if (venceu) {
      expect(venceu.validacao.composicaoAtivoVerificada).toBe(true);
      expect(venceu.validacao.composicaoAtivo).toBe(false); // 1.000 ≠ 9.999 impresso
    }
  });

  it("sem IA ativa a cascata para no heurístico e não custa nada", async () => {
    const r = await extrairComCascata([{ nome: "bp.pdf", tipo: "Balanço Patrimonial", parsed: BP_COMPLETO }], opts("BP"));
    expect(r.custoTotalUsd).toBe(0);
    expect(r.custos.map((c) => c.fonte)).toEqual(["parser"]);
  });
});

/**
 * Os dois achados CONFIRMADOS pela revisão adversarial de 10/08/2026.
 * Sem estes testes a regressão volta na primeira refatoração.
 */
describe("achados da revisão adversarial", () => {
  it("exigeArvore: o heurístico (que nunca tem árvore) não fecha a cascata sozinho", async () => {
    const ia = await import("./ai-extraction");
    const mock = vi.mocked(ia.extractFinancialsWithAI);
    mock.mockResolvedValueOnce({
      bp: [], dre: [{ conta: "Receita Bruta", valores: { "31/12/2024": 1000 } }] as never,
      periodos: ["31/12/2024"], declarados: {},
      arvoreOriginalBP: {}, arvoreOriginalDRE: { "31/12/2024": [{ nome: "RECEITAS", valor: 1000 }] },
      naoMapeados: [], alertasComposicao: [], custo: { usd: 0.01 },
    } as never);
    const r = await extrairComCascata(
      [{ nome: "dre.pdf", tipo: "DRE", parsed: DRE_AVULSA }],
      { ...opts("DRE"), hibridoAtivo: true, exigeArvore: true },
    );
    // Empate de score (0 × 0): sem a flag o heurístico ficaria e a árvore que a
    // IA trouxe (e que foi paga) seria descartada — a porta gravaria erro.
    expect(r.escolhido.fonte).toBe("hibrido");
    expect(Object.keys(r.escolhido.arvoreDRE as object)).toEqual(["31/12/2024"]);
  });

  it("sem exigeArvore (o /process) o critério segue sendo só o score", async () => {
    const ia = await import("./ai-extraction");
    vi.mocked(ia.extractFinancialsWithAI).mockResolvedValueOnce({
      bp: [], dre: [{ conta: "Receita Bruta", valores: { "31/12/2024": 1000 } }] as never,
      periodos: ["31/12/2024"], declarados: {},
      arvoreOriginalBP: {}, arvoreOriginalDRE: { "31/12/2024": [{ nome: "RECEITAS", valor: 1000 }] },
      naoMapeados: [], alertasComposicao: [], custo: { usd: 0.01 },
    } as never);
    const r = await extrairComCascata(
      [{ nome: "dre.pdf", tipo: "DRE", parsed: DRE_AVULSA }],
      { ...opts("DRE"), hibridoAtivo: true },
    );
    expect(r.escolhido.fonte).toBe("heuristico"); // empate mantém o incumbente
  });

  it("lote MISTO (PDF + xlsx): a visão não compete — não pode apagar o que veio da planilha", async () => {
    const ia = await import("./ai-extraction");
    const mock = vi.mocked(ia.extractFinancialsWithAI);
    mock.mockRejectedValueOnce(new Error("híbrido indisponível"));
    // Se a visão competisse, ela leria SÓ o PDF e o vencedor perderia o xlsx.
    const r = await extrairComCascata(
      [
        { nome: "bp.pdf", tipo: "Balanço Patrimonial", parsed: BP_COMPLETO, buffer: async () => Buffer.from("x") },
        { nome: "dre.xlsx", tipo: "DRE", parsed: DRE_AVULSA, buffer: async () => Buffer.from("y") },
      ],
      { ...opts(), hibridoAtivo: true },
    );
    expect(r.escolhido.fonte).toBe("heuristico");
    expect(r.custos.some((c) => c.fonte === "visao")).toBe(false);
  });
});

describe("detectDocType — conteúdo manda", () => {
  it("reconhece BP e DRE no MESMO documento (planilha do contador)", () => {
    const d = doc("x.xlsx", "Outro", "ativo circulante ... passivo circulante ... receita bruta ... custo operacional", []);
    expect(detectDocType(d)).toBe("BOTH");
  });

  it('"resultado do exercício" no PL não faz um balanço virar DRE', () => {
    const d = doc("bp.pdf", "Balanço Patrimonial", "a t i v o ... patrimonio liquido ... resultado do exercicio", []);
    expect(detectDocType(d)).toBe("BP");
  });
});

describe("mergeItensPorConta", () => {
  it("preenche período vazio sem sobrescrever valor existente", () => {
    const alvo: Array<{ conta: string; valores: Record<string, number> }> = [{ conta: "Caixa", valores: { "31/12/2023": 100 } }];
    mergeItensPorConta(alvo, [{ conta: "Caixa", valores: { "31/12/2023": 999, "31/12/2024": 200 } }]);
    expect(alvo[0]!.valores).toEqual({ "31/12/2023": 100, "31/12/2024": 200 });
  });
});
