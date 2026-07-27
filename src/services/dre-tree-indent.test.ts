import { describe, it, expect } from "vitest";
import { construirArvoreDREporIndentacao } from "./dre-tree-indent";
import type { ExtractedRow } from "./parser";

// Regressões do caso AOCP (visualizador SPED, 2026-07-27): a cascata caía no heurístico
// (soma pai+filhos → receita ~2× a declarada) quando a IA falhava/era pulada. A árvore
// determinística fecha a família SPED com custo zero — mas SÓ com a prova de partição.

const P = "31/12/2025";
const linha = (conta: string, valor: number, indent: number): ExtractedRow => ({
  conta,
  valores: { [P]: valor },
  indent,
});

// Espelho fiel (reduzido) da DRE AOCP 2025: seções com filhos, subtotais declarados
// intercalados como linhas ("Receita Líquida" é até PAI contextual dos custos no documento).
const DRE_SPED: ExtractedRow[] = [
  linha("Receita Operacional", 5435708.05, 9),
  linha("SERVIÇOS PRESTADOS", 1910411, 12),
  linha("ARRENDAMENTO", 3525297.05, 12),
  linha("Deducoes", -198403.33, 9),
  linha("IMPOSTOS S/ VENDAS, SERVIÇOS E ARRENDAMENTO", -198403.33, 12),
  linha("Receita Líquida", 5237304.72, 8),
  linha("Custos Mercadorias Vendidas", -200, 9),
  linha("CUSTOS OPERACIONAIS", -200, 11),
  linha("Lucro Bruto", 5237104.72, 7),
  linha("Despesas Administrativas", -1922592.11, 9),
  linha("DESPESAS C/ PESSOAL", -304757.85, 12),
  linha("DESPESAS C/ADMINISTRAÇÃO", -1617834.26, 12),
  linha("Despesas Financeiras", -1436230.92, 9),
  linha("DESPESAS FINANCEIRAS", -1436230.92, 13),
  linha("Receitas Financeiras", 4036.55, 9),
  linha("RECEITAS FINANCEIRAS", 4036.55, 13),
  linha("Resultado operacional líquido", 1882318.24, 6),
  linha("Receitas Não Operacionais", 151738.03, 9),
  linha("RESULTADOS NÃO-OPERACIONAIS", 151738.03, 11),
  linha("Resultado Antes do IR", 2034056.27, 5),
  linha("Provisões", -625457.83, 9),
  linha("PROVISÃO P/CONTR. SOCIAL", -171915.31, 12),
  linha("PROVISÃO P/IMPOSTO DE RENDA", -453542.52, 12),
  linha("LUCRO LÍQUIDO DO EXERCÍCIO", 1408598.44, 4),
];

describe("construirArvoreDREporIndentacao — família SPED", () => {
  it("reconstrói seções com filhos, separa declarados e prova a partição no LL", () => {
    const r = construirArvoreDREporIndentacao(DRE_SPED, [P]);
    expect(r).not.toBeNull();
    const secoes = r!.secoes[P];
    // Subtotais declarados/estruturais NÃO são seções ("RESULTADOS NÃO-OPERACIONAIS",
    // plural, É folha e sobrevive dentro de "Receitas Não Operacionais").
    const nomes = secoes.map((s) => s.nome);
    expect(nomes).toContain("Receita Operacional");
    expect(nomes).toContain("Provisões");
    expect(nomes).not.toContain("Receita Líquida");
    expect(nomes).not.toContain("Lucro Bruto");
    expect(nomes).not.toContain("Resultado Antes do IR");
    // Filhos preservados na seção certa (o fold precisa deles para o detalhe).
    const rec = secoes.find((s) => s.nome === "Receita Operacional")!;
    expect(rec.filhos?.map((f) => f.nome)).toEqual(["SERVIÇOS PRESTADOS", "ARRENDAMENTO"]);
    const naoOp = secoes.find((s) => s.nome === "Receitas Não Operacionais")!;
    expect(naoOp.filhos?.map((f) => f.nome)).toEqual(["RESULTADOS NÃO-OPERACIONAIS"]);
    // Declarados fiéis ao documento (a validação confronta contra eles).
    expect(r!.declarados[P]).toEqual({
      "Receita Líquida": 5237304.72,
      "Lucro Bruto": 5237104.72,
      "Lucro Líquido": 1408598.44,
    });
    // A prova: Σ seções = LL declarado (partição fechada).
    const soma = secoes.reduce((s, x) => s + x.valor, 0);
    expect(soma).toBeCloseTo(1408598.44, 1);
  });

  it("recusa (null) quando a partição NÃO fecha com o LL declarado", () => {
    const adulterada = DRE_SPED.map((l) =>
      l.conta === "Despesas Administrativas" ? { ...l, valores: { [P]: -1000000 } } : l
    );
    expect(construirArvoreDREporIndentacao(adulterada, [P])).toBeNull();
  });

  it("recusa (null) sem Lucro Líquido declarado — não há prova possível", () => {
    const semLL = DRE_SPED.filter((l) => l.conta !== "LUCRO LÍQUIDO DO EXERCÍCIO");
    expect(construirArvoreDREporIndentacao(semLL, [P])).toBeNull();
  });

  it("recusa (null) linhas sem indent (cache legado sem hierarquia confiável)", () => {
    const semIndent = DRE_SPED.map(({ conta, valores }) => ({ conta, valores }));
    expect(construirArvoreDREporIndentacao(semIndent as ExtractedRow[], [P])).toBeNull();
  });

  it("multi-período: prova cada período e monta as seções dos dois", () => {
    const P2 = "31/12/2024";
    const duplas: ExtractedRow[] = DRE_SPED.map((l) => ({
      ...l,
      valores: { [P]: l.valores[P], [P2]: l.valores[P] * 2 },
    }));
    const r = construirArvoreDREporIndentacao(duplas, [P, P2]);
    expect(r).not.toBeNull();
    expect(Object.keys(r!.secoes).sort()).toEqual([P2, P].sort());
    expect(r!.declarados[P2]["Lucro Líquido"]).toBeCloseTo(2817196.88, 1);
  });
});
