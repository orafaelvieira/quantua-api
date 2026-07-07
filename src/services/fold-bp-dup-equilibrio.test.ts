import { vi, describe, it, expect } from "vitest";

// foldBP não chama a IA, mas o módulo instancia o client no load — mock do SDK e da env.
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() } } }));
vi.mock("../config/env", () => ({ env: { anthropicApiKey: "test-key" } }));

import { foldBP } from "./ai-extraction";

const subtotalDe = (bp: any[], classif: string, p: string) =>
  bp.find((l) => l.classificacao === classif && l.nivel === 1)?.valores?.[p] ?? 0;

// RESÍDUO do detectaPaisFlat: quando o grupo tem hierarquia PARCIAL (algum item veio
// aninhado), a reconstrução de pais é pulada e um subtotal repetido vira folha âmbar,
// somando em DUPLICIDADE. A exclusão automática usa prova dupla: a linha parece
// subtotal (subconjunto dos irmãos / duplicata / nome "total") E removê-la fecha o
// balanço (Ativo = Passivo), sendo a ÚNICA âmbar que fecha.
describe("foldBP — exclusão automática de subtotal duplicado por prova de equilíbrio", () => {
  it("exclui o total repetido em grupo semi-hierárquico (soma dos irmãos + fecha o balanço)", () => {
    const arvore = {
      "2024": {
        grupos: {
          "Ativo Circulante": [
            { nome: "CAIXA", valor: 600000 },
            { nome: "CLIENTES", valor: 400000 },
          ],
          "Passivo Circulante": [
            {
              nome: "FORNECEDORES", valor: 800000,
              filhos: [
                { nome: "FORNECEDORES NACIONAIS", valor: 500000 },
                { nome: "FORNECEDORES ESTRANGEIROS", valor: 300000 },
              ],
            },
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 200000 },
            // Total da seção repetido no fim (captura flat no meio de grupo aninhado):
            // 800.000 + 200.000 = 1.000.000 — com ele o Passivo dobra e o balanço quebra.
            { nome: "TOTAL EXIGIBILIDADES", valor: 1000000 },
          ],
        },
      },
    } as any;
    const { bp, naoMapeados } = foldBP(arvore, ["2024"]);
    // PC = 1.000.000 (sem a duplicidade) e o balanço fecha: Ativo 1.000.000 = Passivo 1.000.000
    expect(subtotalDe(bp, "PC", "2024")).toBeCloseTo(1000000, 1);
    expect(subtotalDe(bp, "AC", "2024")).toBeCloseTo(1000000, 1);
    // A linha excluída NÃO fica âmbar (não pede classificação) e carrega a prova no destino
    expect(naoMapeados.find((n) => n.nome === "TOTAL EXIGIBILIDADES")).toBeUndefined();
    const linha = arvore["2024"].grupos["Passivo Circulante"][2];
    expect(linha.destino).toContain("subtotal duplicado");
  });

  it("duplicata exata por quebra de página (mesmo nome+valor, ambas âmbar) — exclui UMA", () => {
    const arvore = {
      "2024": {
        grupos: {
          "Ativo Circulante": [
            { nome: "DISPONIBILIDADES", valor: 700000, filhos: [{ nome: "CAIXA", valor: 700000 }] },
          ],
          "Passivo Circulante": [
            { nome: "INSTITUIÇÕES FINANCEIRAS XPTO", valor: 500000 },
            { nome: "INSTITUIÇÕES FINANCEIRAS XPTO", valor: 500000 }, // repetida na página seguinte
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 200000 },
          ],
        },
      },
    } as any;
    const { bp, naoMapeados } = foldBP(arvore, ["2024"]);
    expect(subtotalDe(bp, "PC", "2024")).toBeCloseTo(700000, 1); // 500k UMA vez + 200k tributárias
    // Sobra exatamente UMA âmbar da conta (a outra foi excluída como duplicata)
    expect(naoMapeados.filter((n) => n.nome === "INSTITUIÇÕES FINANCEIRAS XPTO").length).toBe(1);
  });

  it("NÃO exclui conta real que por acaso fecharia o balanço mas não parece subtotal", () => {
    const arvore = {
      "2024": {
        grupos: {
          "Ativo Circulante": [
            { nome: "DISPONIBILIDADES", valor: 700000, filhos: [{ nome: "CAIXA", valor: 700000 }] },
          ],
          "Passivo Circulante": [
            // Desequilíbrio real (falta contraparte no Ativo): a âmbar de 500.000 fecharia
            // o balanço se removida, mas não é soma de irmãos, duplicata nem "total".
            { nome: "CONTAS DIVERSAS A PAGAR", valor: 500000 },
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 200000 },
          ],
        },
      },
    } as any;
    const { bp, naoMapeados } = foldBP(arvore, ["2024"]);
    expect(subtotalDe(bp, "PC", "2024")).toBeCloseTo(700000, 1); // nada excluído
    expect(naoMapeados.find((n) => n.nome === "CONTAS DIVERSAS A PAGAR")).toBeDefined();
  });

  it("ambíguo (duas âmbar distintas fechariam o balanço) → não mexe, ficam âmbar", () => {
    const arvore = {
      "2024": {
        grupos: {
          "Ativo Circulante": [
            { nome: "DISPONIBILIDADES", valor: 900000, filhos: [{ nome: "CAIXA", valor: 900000 }] },
          ],
          "Passivo Circulante": [
            { nome: "FORNECEDORES ML", valor: 300000, filhos: [{ nome: "FORN NACIONAIS", valor: 300000 }] },
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 300000 },
            // Duas linhas de "total" com o MESMO valor — qual excluir? Nenhuma: analista decide.
            { nome: "TOTAL OBRIGAÇÕES", valor: 300000 },
            { nome: "SOMA EXIGÍVEL", valor: 300000 },
          ],
        },
      },
    } as any;
    const { naoMapeados } = foldBP(arvore, ["2024"]);
    expect(naoMapeados.find((n) => n.nome === "TOTAL OBRIGAÇÕES")).toBeDefined();
    expect(naoMapeados.find((n) => n.nome === "SOMA EXIGÍVEL")).toBeDefined();
  });
});
