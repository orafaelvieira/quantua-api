import { describe, it, expect } from "vitest";
import { prepararArvore, converterBalancete } from "./balancete-conversao";
import type { BalanceteParseado, LinhaBalancete } from "./balancete-parser";


/**
 * CASO CLOROFILA (13/08/2026) — o pior defeito do dia: PL como raiz própria ia
 * inteiro para a DRE, e a DRE verdadeira (fechada em zero pós-encerramento) era
 * descartada como espelho. O IBR concluiu com capital social como "receita".
 */
describe("PL como raiz própria + DRE encerrada dentro do grupo (caso Clorofila)", () => {
  const linha = (classificacao: string, nome: string, saldoAnterior: number, debito: number, credito: number, saldoAtual: number): LinhaBalancete =>
    ({ classificacao, nome, saldoAnterior, debito, credito, saldoAtual } as LinhaBalancete);

  const documento = (): BalanceteParseado => ({
    origem: "teste",
    avisos: [],
    periodoInicio: "01/01/2023",
    periodoFim: "31/12/2023",
    linhas: [
      linha("1", "Ativo", 0, 1000, 0, 1000),
      linha("1.1", "Caixa", 0, 1000, 0, 1000),
      linha("2", "Passivo Circulante", 0, 0, 200, 200),
      linha("2.1", "Fornecedores", 0, 0, 200, 200),
      linha("3", "Patrimonio Liquido", 0, 0, 800, 800),
      linha("3.1", "Capital Social", 0, 0, 500, 500),
      linha("3.2", "Resultado Apurado no Periodo", 0, 0, 300, 300),
      // DRE encerrada DENTRO do grupo: receita − despesa − transferência = 0
      linha("4", "Resultado Liquido do Periodo", 0, 900, 900, 0),
      linha("4.1", "Receitas de Vendas", 0, 0, 500, 500),
      linha("4.2", "Despesas Gerais", 0, 200, 0, 200),
      linha("4.3", "Transferencias", 0, 700, 400, 300),
    ],
  } as unknown as BalanceteParseado);

  it("PL vai para o tipo 'pl', nunca para a DRE", () => {
    const arv = prepararArvore(documento());
    const pl = arv.grupos.find((g) => g.no.linha.nome === "Patrimonio Liquido");
    expect(pl?.tipo).toBe("pl");
  });

  it("a única DRE não é descartada como espelho, e a perna de encerramento sai por prova cruzada com o PL", () => {
    const conv = converterBalancete(documento());
    const dre = Object.values(conv.arvoreDRE ?? {})[0] as Array<{ nome: string; valor: number }>;
    expect(dre).toBeDefined();
    const nomes = dre.map((x) => x.nome);
    expect(nomes).toContain("Receitas de Vendas");
    expect(nomes).not.toContain("Transferencias");           // perna de encerramento fora
    expect(nomes.some((n) => /Capital/.test(n))).toBe(false); // PL jamais na DRE
    const soma = dre.reduce((s, x) => s + x.valor, 0);
    expect(Math.abs(soma - 300)).toBeLessThan(0.01);          // = Resultado Apurado no Periodo
  });

  it("filhos da raiz PL caem no balde Patrimônio Líquido do BP — nunca em Passivo Circulante", () => {
    const conv = converterBalancete(documento());
    const bp = Object.values(conv.arvoreBP ?? {})[0] as any;
    const baldes = bp?.grupos ?? bp;
    const pl = (baldes["Patrimônio Líquido"] ?? []) as Array<{ nome: string }>;
    const pc = (baldes["Passivo Circulante"] ?? []) as Array<{ nome: string }>;
    expect(pl.map((x) => x.nome)).toEqual(expect.arrayContaining(["Capital Social", "Resultado Apurado no Periodo"]));
    expect(pc.some((x) => /Capital|Resultado/.test(x.nome))).toBe(false);
  });

  it("fechamento com PL assinado: A = P + PL, delta zero", () => {
    const conv = converterBalancete(documento());
    expect(conv.provas.fechamento.ok).toBe(true);
    expect(Math.abs(conv.provas.fechamento.delta)).toBeLessThan(0.01);
  });
});
