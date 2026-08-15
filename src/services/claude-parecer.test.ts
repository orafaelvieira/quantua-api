/**
 * O ESSENCIAL (parecerExecutivo) — o que o parser aceita da IA.
 *
 * O ponto que estes testes protegem: no painel executivo o número aparece GRANDE,
 * e número grande passa a impressão de vir do motor. Por isso a IA escolhe QUAL
 * indicador importa (juízo editorial) e o motor diz QUANTO — a IA nunca escreve
 * o valor. Nome que não existe na série morre aqui, não na tela do cliente.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const criar = vi.fn();

vi.mock("./ai-extraction", async (original) => {
  const real = await original<typeof import("./ai-extraction")>();
  return { ...real, createWithRetry: (...args: unknown[]) => criar(...args) };
});

// Import estático: `vi.mock` é içado acima dos imports pelo vitest, então o
// módulo já enxerga o mock. (Top-level await não compila no tsconfig da API.)
import { generateAnalysis } from "./claude";

const P = "31/12/2024";
const P0 = "31/12/2023";

const INDICADORES = [
  { nome: "Margem EBITDA", valores: { [P0]: 0.21, [P]: 0.29 }, tipoDado: "%" },
  { nome: "Liquidez Corrente", valores: { [P0]: 2.1, [P]: 2.8 }, tipoDado: "Índice" },
  { nome: "Prazo Médio de Recebimento", valores: { [P0]: 52, [P]: 61 }, tipoDado: "Dias" },
];

/** Resposta mínima que passa no guard de campos essenciais. */
function resposta(parecer: unknown): { content: Array<{ type: string; text: string }>; usage: { input_tokens: number; output_tokens: number } } {
  const corpo = {
    semaforo: [{ area: "Liquidez", status: "ok", comentario: "x" }],
    opcoesEstrategicas: [{ pilar: "operational_excellence", titulo: "x", descricao: "y" }],
    swot: { forcas: ["f"], fraquezas: [], oportunidades: [], riscos: [] },
    confianca: 80,
    parecerExecutivo: parecer,
  };
  return { content: [{ type: "text", text: JSON.stringify(corpo) }], usage: { input_tokens: 100, output_tokens: 200 } };
}

const gerar = (parecer: unknown) => {
  criar.mockResolvedValueOnce(resposta(parecer));
  return generateAnalysis(INDICADORES, [P0, P], { razaoSocial: "Teste SA", setor: "Serviços", porte: "Média" }, P);
};

beforeEach(() => {
  criar.mockReset();
});

describe("O essencial — parecer executivo", () => {
  it("guarda o indicador escolhido pela IA e a leitura, sem valor escrito por ela", async () => {
    const { result } = await gerar({
      tese: "A empresa saiu da pressão de caixa e opera com folga.",
      numeros: [
        { indicador: "Margem EBITDA", leitura: "Subiu de 21% para 29%, o melhor patamar da série." },
        { indicador: "Liquidez Corrente", leitura: "Cobre quase três vezes o passivo de curto prazo." },
      ],
    });
    expect(result.parecerExecutivo?.numeros).toEqual([
      { indicador: "Margem EBITDA", leitura: "Subiu de 21% para 29%, o melhor patamar da série." },
      { indicador: "Liquidez Corrente", leitura: "Cobre quase três vezes o passivo de curto prazo." },
    ]);
    // Nenhum campo de valor sobrevive ao parser, mesmo que a IA insista.
    expect(JSON.stringify(result.parecerExecutivo)).not.toMatch(/"valor"/);
  });

  it("descarta indicador que não existe na série — nome inventado não chega à tela", async () => {
    const { result } = await gerar({
      tese: "Tese válida.",
      numeros: [
        { indicador: "Margem EBITDA", leitura: "ok" },
        { indicador: "EBITDA Ajustado Recorrente", leitura: "indicador que a série não tem" },
        { indicador: "Margem de Contribuição", leitura: "outro que não existe" },
      ],
    });
    expect(result.parecerExecutivo?.numeros).toEqual([{ indicador: "Margem EBITDA", leitura: "ok" }]);
  });

  it("aceita o nome antigo do template e grava o nome que está no dado", async () => {
    // A IA pode citar "Margem Operacional" (nome anterior de Margem EBITDA). A
    // tela procura por igualdade exata: o parser normaliza para o nome real.
    criar.mockResolvedValueOnce(resposta({ tese: "t", numeros: [{ indicador: "Margem Operacional", leitura: "ok" }] }));
    const { result } = await generateAnalysis(
      [{ nome: "Margem Operacional", valores: { [P]: 0.29 }, tipoDado: "%" }],
      [P0, P], { razaoSocial: "Teste SA", setor: "Serviços", porte: "Média" }, P,
    );
    expect(result.parecerExecutivo?.numeros).toEqual([{ indicador: "Margem Operacional", leitura: "ok" }]);
  });

  it("leitura vazia derruba o item — indicador solto não diz nada a quem decide", async () => {
    const { result } = await gerar({ tese: "t", numeros: [{ indicador: "Margem EBITDA", leitura: "   " }] });
    expect(result.parecerExecutivo?.numeros).toEqual([]);
  });

  it("sem tese não há parecer: meio bloco no topo do relatório é pior que nenhum", async () => {
    const { result } = await gerar({ numeros: [{ indicador: "Margem EBITDA", leitura: "ok" }], proteger: ["algo"] });
    expect(result.parecerExecutivo).toBeUndefined();
    expect(result.semaforo).toHaveLength(1); // o resto da análise segue válido
  });

  it("análise sem o campo continua válida — o parecer não entra no guard", async () => {
    const { result } = await gerar(undefined);
    expect(result.parecerExecutivo).toBeUndefined();
    expect(result.swot.forcas).toEqual(["f"]);
  });

  it("decisões e proteções passam como texto, sem exigir valor", async () => {
    const { result } = await gerar({
      tese: "t",
      decisoes: [
        { decisao: "Renegociar o prazo com o fornecedor principal", prazo: "0–30d", valor: "R$ 400 mil", porque: "libera caixa" },
        { decisao: "Revisar a política de preço da linha B", prazo: "30–90d", valor: null, porque: "margem abaixo dos pares" },
        { semValor: true },
      ],
      proteger: ["Contrato de exclusividade com o distribuidor", "  ", 42],
    });
    expect(result.parecerExecutivo?.decisoes).toHaveLength(2);
    expect(result.parecerExecutivo?.proteger).toEqual(["Contrato de exclusividade com o distribuidor"]);
  });
});
