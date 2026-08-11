/**
 * GARANTIAS 6 e 7 — as travas do IBR.
 *
 * 6: "documentos que ainda não foram conciliados 100% não podem ser usados em
 *    IBR" — a régua vive num lugar só (conciliacaoDoDocumento), senão a tela
 *    bloqueia e a API aceita.
 * 7: "o sistema não pode permitir a geração de um novo IBR com os mesmos
 *    documentos contábeis já utilizados, deverá informar ao usuário" — a
 *    comparação é do CONJUNTO, e os fluxos legítimos não podem quebrar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { conciliacaoDoDocumento } from "./conciliacao-documento";
import { conjuntoJaUsadoEmOutroIBR } from "./fixacao-pool";

// `vi.hoisted` porque `vi.mock` é içado para o topo do arquivo: uma const
// comum ainda não existe quando a fábrica do mock roda.
const prismaMock = vi.hoisted(() => ({
  document: { findUnique: vi.fn(), findMany: vi.fn() },
  company: { findUnique: vi.fn() },
  accountDictionary: { findMany: vi.fn() },
}));
vi.mock("../db/client", () => ({ prisma: prismaMock }));
vi.mock("./escopo-acesso", () => ({ resolverEscopoAcesso: vi.fn(async () => ({ scopeUserIds: ["u1"] })) }));
vi.mock("./model-version", () => ({
  loadActiveBPModel: vi.fn(async () => ({ lines: [], names: [], classifMap: new Map() })),
  loadActiveDREModel: vi.fn(async () => ({ lines: [], extrasPorBloco: {} })),
}));

// Import estático: `vi.mock` é içado pelo vitest, então o mock já está de pé.
// (await no topo do módulo quebra o `tsc` do build — pegadinha do deploy.)

const provasBoas = {
  partidaDobrada: { debitos: 100, creditos: 100, delta: 0, folhas: 4, verificavel: true, ok: true },
  fechamento: { ativo: 100, passivo: 100, resultadoAcumulado: 0, delta: 0, ok: true },
  linhas: { total: 4, coerentes: 4, ok: true, incoerentes: [] },
  exercicioEncerrado: false,
};

const docBalancete = (conteudo: unknown) => ({
  id: "d1", nome: "Balancete 05.2026.pdf", tipo: "Balancete", hash: "h1", companyId: "c1",
  leituraPorta: { conteudo, hashArquivo: "h1" },
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.company.findUnique.mockResolvedValue({ userId: "u1" });
  prismaMock.accountDictionary.findMany.mockResolvedValue([]);
});

describe("garantia 6 — conciliação de um documento", () => {
  it("material complementar não é conciliável (não vira número, não bloqueia)", async () => {
    prismaMock.document.findUnique.mockResolvedValue({ ...docBalancete({}), tipo: "Material complementar" });
    expect(await conciliacaoDoDocumento("d1")).toBeNull();
  });

  it("leitura de OUTRA versão do arquivo não vale — pede a leitura da vigente", async () => {
    prismaMock.document.findUnique.mockResolvedValue({ ...docBalancete({ provas: provasBoas, linhas: [] }), hash: "h2" });
    const r = await conciliacaoDoDocumento("d1");
    expect(r?.ok).toBe(false);
    expect(r?.motivos[0]).toMatch(/leitura ainda não rodou/);
  });

  it("erro de leitura reprova com o próprio motivo", async () => {
    prismaMock.document.findUnique.mockResolvedValue(docBalancete({ erro: "PDF sem camada de texto (escaneado?)" }));
    const r = await conciliacaoDoDocumento("d1");
    expect(r?.ok).toBe(false);
    expect(r?.motivos[0]).toMatch(/escaneado/);
  });

  it("partida dobrada que não fecha reprova com a diferença", async () => {
    prismaMock.document.findUnique.mockResolvedValue(docBalancete({
      linhas: [], provas: { ...provasBoas, partidaDobrada: { ...provasBoas.partidaDobrada, creditos: 98.2, delta: 1.8, ok: false } },
    }));
    const r = await conciliacaoDoDocumento("d1");
    expect(r?.ok).toBe(false);
    expect(r?.motivos.join(" ")).toMatch(/partida dobrada/);
  });

  it("demonstrativo que não fechou a integridade reprova nomeando o que falhou", async () => {
    prismaMock.document.findUnique.mockResolvedValue({
      id: "d2", nome: "BP 2024.pdf", tipo: "Balanço Patrimonial", hash: "h1", companyId: "c1",
      leituraPorta: {
        hashArquivo: "h1",
        conteudo: { integridade: { fonte: "hibrido", score: 1, scoreMax: 2, fecha: false, equacaoPatrimonial: false, composicaoAtivo: true, composicaoPassivo: true } },
      },
    });
    const r = await conciliacaoDoDocumento("d2");
    expect(r?.ok).toBe(false);
    expect(r?.motivos.join(" ")).toMatch(/Ativo ≠ Passivo/);
  });
});

describe("garantia 7 — mesmo conjunto de documentos em outro IBR", () => {
  const meus = [
    { fixadoDeId: "p1", tipo: "Balancete" },
    { fixadoDeId: "p2", tipo: "Balanço Patrimonial" },
  ];

  it("outro IBR com o MESMO conjunto: acusa e identifica", async () => {
    prismaMock.document.findMany
      .mockResolvedValueOnce(meus)
      .mockResolvedValueOnce([
        { analysisId: "a2", fixadoDeId: "p1", tipo: "Balancete", analysis: { nome: "IBR Belagro 2025", status: "Concluída" } },
        { analysisId: "a2", fixadoDeId: "p2", tipo: "Balanço Patrimonial", analysis: { nome: "IBR Belagro 2025", status: "Concluída" } },
      ]);
    const r = await conjuntoJaUsadoEmOutroIBR("a1", "c1");
    expect(r?.nome).toBe("IBR Belagro 2025");
    expect(r?.documentos).toBe(2);
  });

  it("IBR CANCELADO não conta — não é entrega", async () => {
    prismaMock.document.findMany
      .mockResolvedValueOnce(meus)
      .mockResolvedValueOnce([
        { analysisId: "a2", fixadoDeId: "p1", tipo: "Balancete", analysis: { nome: "IBR velho", status: "Cancelada" } },
        { analysisId: "a2", fixadoDeId: "p2", tipo: "Balanço Patrimonial", analysis: { nome: "IBR velho", status: "Cancelada" } },
      ]);
    expect(await conjuntoJaUsadoEmOutroIBR("a1", "c1")).toBeNull();
  });

  it("balancete COMPARTILHADO entre períodos diferentes não dispara", async () => {
    // O outro IBR usa só UM dos meus documentos — escopo diferente, não repetição.
    prismaMock.document.findMany
      .mockResolvedValueOnce(meus)
      .mockResolvedValueOnce([
        { analysisId: "a2", fixadoDeId: "p1", tipo: "Balancete", analysis: { nome: "IBR 2024", status: "Concluída" } },
      ]);
    expect(await conjuntoJaUsadoEmOutroIBR("a1", "c1")).toBeNull();
  });

  it("material complementar não entra na comparação", async () => {
    prismaMock.document.findMany
      .mockResolvedValueOnce([...meus, { fixadoDeId: "p9", tipo: "Material complementar" }])
      .mockResolvedValueOnce([
        { analysisId: "a2", fixadoDeId: "p1", tipo: "Balancete", analysis: { nome: "IBR X", status: "Em produção" } },
        { analysisId: "a2", fixadoDeId: "p2", tipo: "Balanço Patrimonial", analysis: { nome: "IBR X", status: "Em produção" } },
      ]);
    const r = await conjuntoJaUsadoEmOutroIBR("a1", "c1");
    expect(r?.documentos).toBe(2); // p9 fora da conta
  });

  it("IBR sem documento fixado não dispara", async () => {
    prismaMock.document.findMany.mockResolvedValueOnce([]);
    expect(await conjuntoJaUsadoEmOutroIBR("a1", "c1")).toBeNull();
  });
});
