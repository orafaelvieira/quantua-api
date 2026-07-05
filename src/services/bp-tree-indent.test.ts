import { describe, it, expect } from "vitest";
import { construirArvoreBPporIndentacao } from "./bp-tree-indent";
import { foldBP } from "./ai-extraction";
import { DEFAULT_BP_MODEL } from "./account-mapper";
import type { ParsedDocument } from "./parser";

// Monta um ParsedDocument mínimo (o construtor só lê `doc.raw`).
const doc = (raw: string): ParsedDocument => ({ tipo: "balanco", linhas: [], periodos: [], raw });

const valor = (bp: { conta: string; valores: Record<string, number> }[], conta: string, p: string) =>
  bp.find((l) => l.conta === conta)?.valores[p] ?? 0;

// Raw indentado SINTÉTICO espelhando o Grau-4 da Fibracabos (2020): Passivo Circulante >
// "EXIGÍVEL A CURTO PRAZO" (wrapper = próprio grupo) > 9 contas-folha reais; Ativo Circulante
// com wrappers Disponibilidades/Créditos/Estoques e suas folhas. Ativo = Passivo = 7.957.319,63.
const RAW_GRAU4 = [
  "balanco",
  "322 - FIBRACABOS AMBICOM TECNOLOGIA E MEIO AMB                          PÁGINA: 7",
  "Consolidação: Empresa                          Grau: 4          Encerrado em: 31/12/2020",
  "   ATIVO                                                        7.957.319,63",
  "    ATIVO CIRCULANTE                                            1.413.313,53",
  "      DISPONIBILIDADES                                            266.326,91",
  "       CAIXA                                                       51.625,26",
  "       BANCOS CONTA MOVIMENTO                                     103.471,54",
  "       APLICACOES FINANCEIRAS                                     111.230,11",
  "      CREDITOS                                                    542.763,07",
  "       IMPOSTOS A RECUPERAR                                        76.963,72",
  "       DUPLICATAS A RECEBER                                       442.930,10",
  "       ADIANTAMENTOS                                               22.869,25",
  "      ESTOQUES                                                    604.223,55",
  "       ESTOQUES                                                   604.223,55",
  "    ATIVO NAO CIRCULANTE                                        6.544.006,10",
  "      REALIZAVEL A LONGO PRAZO                                    104.682,69",
  "       CONSORCIOS                                                 102.675,15",
  "       OUTRAS APLICACOES                                            2.007,54",
  "      ATIVO IMOBILIZADO                                         6.439.323,41",
  "       BENS EM OPERACAO                                         6.439.323,41",
  "             TOTAL DO ATIVO                                     7.957.319,63",
  "   PASSIVO                                                      7.957.319,63",
  "    PASSIVO CIRCULANTE                                          5.290.610,85",
  "      EXIGIVEL A CURTO PRAZO                                    5.290.610,85",
  "       FORNECEDORES A PAGAR                                     1.860.814,34",
  "       OBRIGACOES FISCAIS                                          25.966,01",
  "       OBRIGACOES TRABALHISTAS A PAGAR                            164.395,97",
  "       ENCARGOS SOCIAIS A RECOLHER                                 52.007,44",
  "       OUTRAS OBRIGACOES                                           84.603,28",
  "       ADIANTAMENTOS DIVERSOS                                   1.904.756,20",
  "       EMPRESTIMOS E FINANCIAMENTOS                               700.040,88",
  "       PARCEL TRIBUT A RECOLHER                                   109.242,28",
  "       I.R.P.J. E C.S.L.L. A RECOLHER                             388.784,45",
  "    PATRIMONIO LIQUIDO                                          2.666.708,78",
  "      CAPITAL SOCIAL REALIZADO                                    150.000,00",
  "       CAPITAL SOCIAL                                             150.000,00",
  "      RESERVAS DE LUCROS                                        2.673.365,59",
  "       RESERVAS DE LUCROS                                       2.673.365,59",
  "      LUCROS/PREJUIZOS ACUMULADOS                                -156.656,81",
  "       LUCROS/PREJUIZOS ACUMULADOS                               -156.656,81",
  "             TOTAL DO PASSIVO                                   7.957.319,63",
].join("\n");

describe("construirArvoreBPporIndentacao — Grau 4 (caso Fibracabos)", () => {
  const P = "31/12/2020";

  it("reconstrói a árvore não-null e captura as 9 contas-folha do Passivo Circulante", () => {
    const arvore = construirArvoreBPporIndentacao(doc(RAW_GRAU4), [P]);
    expect(arvore).not.toBeNull();
    const cap = arvore![P];
    expect(cap).toBeDefined();

    // Totais fecham (Ativo = Passivo)
    expect(cap.totais!["Ativo Total"]).toBeCloseTo(7957319.63, 2);
    expect(cap.totais!["Passivo Total"]).toBeCloseTo(7957319.63, 2);

    // O wrapper "EXIGÍVEL A CURTO PRAZO" NÃO entra como nó — as 9 filhas sobem direto no grupo.
    const pc = cap.grupos["Passivo Circulante"];
    expect(pc).toBeDefined();
    expect(pc.map((n) => n.nome)).not.toContain("EXIGIVEL A CURTO PRAZO");
    expect(pc.length).toBe(9);
    const somaPC = pc.reduce((s, n) => s + n.valor, 0);
    expect(somaPC).toBeCloseTo(5290610.85, 2);
  });

  it("ao passar por foldBP: as filhas viram contas-folha do modelo e a composição do PC fecha", () => {
    const arvore = construirArvoreBPporIndentacao(doc(RAW_GRAU4), [P])!;
    const { bp } = foldBP(arvore, [P], undefined, DEFAULT_BP_MODEL);

    // As contas com nome canônico caem na LINHA CERTA do modelo (não em "Outros").
    expect(valor(bp, "Fornecedores - CP", P)).toBeCloseTo(1860814.34, 2);
    expect(valor(bp, "Obrigações Trabalhistas - CP", P)).toBeCloseTo(164395.97, 2);
    expect(valor(bp, "Obrigações Tributárias - CP", P)).toBeCloseTo(25966.01, 2);
    expect(valor(bp, "Empréstimos e Financiamentos - CP", P)).toBeCloseTo(700040.88, 2);

    // A composição do PC fecha: soma das linhas-folha = subtotal Passivo Circulante.
    const subtotalPC = valor(bp, "Passivo Circulante", P);
    expect(subtotalPC).toBeCloseTo(5290610.85, 2);
    const folhasPC = [
      "Fornecedores - CP", "Obrigações Trabalhistas - CP", "Obrigações Tributárias - CP",
      "Empréstimos e Financiamentos - CP", "Passivos com Partes Relacionadas - CP",
      "Dividendos e JCP a Pagar", "Despesas Ant. / Adiantamentos - Passivo", "Outros Passivos Circulantes",
    ];
    const somaFolhas = folhasPC.reduce((s, c) => s + valor(bp, c, P), 0);
    expect(somaFolhas).toBeCloseTo(subtotalPC, 2);

    // NÃO sobra TUDO em "Outros Passivos Circulantes": as contas mapeadas saíram do balde.
    const outros = valor(bp, "Outros Passivos Circulantes", P);
    expect(outros).toBeLessThan(subtotalPC);
    const somaMapeadas =
      valor(bp, "Fornecedores - CP", P) +
      valor(bp, "Obrigações Trabalhistas - CP", P) +
      valor(bp, "Obrigações Tributárias - CP", P) +
      valor(bp, "Empréstimos e Financiamentos - CP", P);
    expect(somaMapeadas).toBeGreaterThan(0);
    // As 4 contas canônicas somam ~2.75M — mais da metade do PC não está no balde.
    expect(somaMapeadas).toBeCloseTo(1860814.34 + 164395.97 + 25966.01 + 700040.88, 2);
  });

  it("também quebra o Ativo Circulante em contas-folha do modelo", () => {
    const arvore = construirArvoreBPporIndentacao(doc(RAW_GRAU4), [P])!;
    const { bp } = foldBP(arvore, [P], undefined, DEFAULT_BP_MODEL);
    expect(valor(bp, "Estoques - CP", P)).toBeCloseTo(604223.55, 2);
    expect(valor(bp, "Contas a Receber - CP", P)).toBeCloseTo(442930.10, 2);
    // Ativo Circulante do modelo = subtotal declarado.
    expect(valor(bp, "Ativo Circulante", P)).toBeCloseTo(1413313.53, 2);
  });
});

describe("trava anti-regressão — raw sem indentação confiável → null (fallback LLM)", () => {
  it("tudo no mesmo nível (sem hierarquia ≥3 níveis) → null", () => {
    const raw = [
      "ATIVO CIRCULANTE 1.000.000,00",
      "PASSIVO CIRCULANTE 600.000,00",
      "PATRIMONIO LIQUIDO 400.000,00",
    ].join("\n"); // todas com indent 0 → 1 nível só
    expect(construirArvoreBPporIndentacao(doc(raw), ["2020"])).toBeNull();
  });

  it("Ativo Total ≠ Passivo Total → null (não fecha, cai no LLM)", () => {
    // Mesma forma do Grau 4, mas com o PASSIVO adulterado para NÃO bater com o ATIVO.
    const desbalanceado = RAW_GRAU4.replace(
      "   PASSIVO                                                      7.957.319,63",
      "   PASSIVO                                                      9.000.000,00"
    );
    expect(construirArvoreBPporIndentacao(doc(desbalanceado), ["31/12/2020"])).toBeNull();
  });

  it("faltam grupos essenciais (sem Passivo Circulante) → null", () => {
    const semPC = [
      "   ATIVO                          1.000,00",
      "    ATIVO CIRCULANTE              1.000,00",
      "      DISPONIBILIDADES              1.000,00",
      "       CAIXA                        1.000,00",
      "   PASSIVO                        1.000,00",
      "    PATRIMONIO LIQUIDO            1.000,00",
      "      CAPITAL SOCIAL REALIZADO      1.000,00",
      "       CAPITAL SOCIAL              1.000,00",
    ].join("\n");
    expect(construirArvoreBPporIndentacao(doc(semPC), ["2020"])).toBeNull();
  });
});
