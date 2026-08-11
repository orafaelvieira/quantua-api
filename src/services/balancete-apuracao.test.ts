/**
 * APURAÇÃO/ENCERRAMENTO NÃO É LINHA DE DRE — e a DRE do exercício encerrado
 * não recebe selo verde sem reconciliar.
 *
 * Caso Belagro 2023 (10/08/2026, PRODUÇÃO). O plano de contas traz a raiz
 * "05 RESULTADO LÍQUIDO DO EXERCÍCIO" com débito = crédito = R$ 576.963.484 —
 * puro contra-lançamento de encerramento. A régua antiga procurava a substring
 * "RESULTADO DO EXERC" e não casava com "RESULTADO LÍQUIDO DO EXERCÍCIO" (o
 * "LÍQUIDO" no meio): o grupo virava seção da DRE, a folha caía como pendência
 * para o analista classificar e o valor era despejado em "Outras Despesas
 * Operacionais" — Lucro Líquido de 2023 exibido como −687,9 MILHÕES.
 *
 * A segunda camada: no encerramento as contas de resultado estão zeradas e a
 * DRE é derivada do MOVIMENTO (receita = crédito, gasto = débito). Isso é
 * heurística, não prova — transferência interna entre contas de resultado
 * infla os dois lados. A âncora do próprio documento é a variação do resultado
 * no PL; sem reconciliar, o documento não passa por conferido.
 */
import { describe, it, expect } from "vitest";
import { parseBalanceteMatriz } from "./balancete-tabular";
import { converterBalancete, ehNomeDeApuracao } from "./balancete-conversao";

const CAB = ["Classificação", "Nome da conta contábil", "Saldo anterior", "Débito", "Crédito", "Saldo atual"];
type L = [string, string, string, string, string, string];
const ler = (linhas: L[], janela = "01/01/2023 a 31/12/2023") =>
  converterBalancete(parseBalanceteMatriz([[janela], CAB, ...linhas] as never));
const secoes = (c: ReturnType<typeof converterBalancete>): Array<{ nome: string; valor: number }> => {
  const arv = c.arvoreDRE as Record<string, Array<{ nome: string; valor: number }>>;
  return arv[c.periodoBP] ?? [];
};
const soma = (c: ReturnType<typeof converterBalancete>) => secoes(c).reduce((s, x) => s + x.valor, 0);

/** Encerramento fiel ao Belagro em miniatura: tudo zerado, D = C em todas as
 *  contas de resultado, e a raiz de apuração com o contra-lançamento. */
const ENCERRADO: L[] = [
  ["01", "ATIVO", "800.00", "1000.00", "800.00", "1000.00"],
  ["01.1", "CIRCULANTE", "800.00", "1000.00", "800.00", "1000.00"],
  ["02", "PASSIVO", "800.00", "700.00", "900.00", "1000.00"],
  ["02.1", "FORNECEDORES", "500.00", "700.00", "600.00", "400.00"],
  ["02.3", "PATRIMONIO LIQUIDO", "300.00", "0.00", "300.00", "600.00"],
  ["02.3.4", "RESULTADO ACUMULADO", "300.00", "0.00", "300.00", "600.00"],
  ["02.3.4.01", "Resultado do Exercício", "300.00", "0.00", "300.00", "600.00"],
  ["03", "RECEITAS", "0.00", "1000.00", "1000.00", "0.00"],
  ["03.1", "RECEITA BRUTA", "0.00", "1000.00", "1000.00", "0.00"],
  ["04", "CUSTOS E DESPESAS", "0.00", "700.00", "700.00", "0.00"],
  ["04.1", "CUSTOS", "0.00", "700.00", "700.00", "0.00"],
  ["05", "RESULTADO LIQUIDO DO EXERCICIO", "0.00", "1700.00", "1700.00", "0.00"],
  ["05.1", "RESULTADO LIQUIDO DO EXERCICIO", "0.00", "1700.00", "1700.00", "0.00"],
];

describe("apuração/encerramento fora da DRE (caso Belagro 2023)", () => {
  it('"RESULTADO LÍQUIDO DO EXERCÍCIO" NÃO vira seção da DRE', () => {
    const nomes = secoes(ler(ENCERRADO)).map((s) => s.nome.toUpperCase());
    expect(nomes.some((n) => n.includes("RESULTADO LIQUIDO"))).toBe(false);
    expect(nomes).toContain("RECEITA BRUTA");
  });

  it("o contra-lançamento não entra no resultado (era o estrago: dobrava a DRE)", () => {
    // Receita 1.000 − custo 700 = 300. Com a apuração vazando entrava −1.700.
    expect(soma(ler(ENCERRADO))).toBeCloseTo(300, 2);
  });

  it("a folha de apuração não é oferecida ao analista para classificar", () => {
    const arv = ler(ENCERRADO).arvoreDRE as Record<string, Array<{ nome: string }>>;
    const todos: string[] = [];
    const anda = (its: Array<{ nome: string; filhos?: Array<{ nome: string }> }>) => {
      for (const i of its) { todos.push(i.nome.toUpperCase()); if (i.filhos?.length) anda(i.filhos as never); }
    };
    anda((arv[Object.keys(arv)[0]!] ?? []) as never);
    expect(todos.some((n) => n.includes("RESULTADO LIQUIDO DO EXERCICIO"))).toBe(false);
  });

  it("conta legítima com 'resultado' no nome CONTINUA na DRE", () => {
    const comLegitimas: L[] = [
      ...ENCERRADO,
      ["04.2", "RESULTADO DE EQUIVALENCIA PATRIMONIAL", "0.00", "50.00", "50.00", "0.00"],
      ["04.3", "RESULTADO DE POSICOES DO MERCADO", "0.00", "30.00", "30.00", "0.00"],
    ];
    const nomes = secoes(ler(comLegitimas)).map((s) => s.nome.toUpperCase());
    expect(nomes).toContain("RESULTADO DE EQUIVALENCIA PATRIMONIAL");
    expect(nomes).toContain("RESULTADO DE POSICOES DO MERCADO");
  });
});

/**
 * VETO DA ECONOMIA PRÓPRIA (caso EXTRAMED, achado na revisão adversarial).
 * O grupo se chama "CONTAS DE DESTINAÇÃO/APURAÇÃO DE RESULTADO" mas carrega
 * IRPJ 1.929.304,98 e CSLL 720.481,33 — despesa de verdade. Suprimir pelo nome
 * apagaria o IR/CSLL da DRE e inflaria o lucro em R$ 2,65 milhões.
 */
describe("grupo com nome de apuração mas conteúdo econômico REAL fica na DRE", () => {
  const comImpostos: L[] = [
    ["01", "ATIVO", "0.00", "10000.00", "0.00", "10000.00"],
    ["01.1", "Caixa", "0.00", "10000.00", "0.00", "10000.00"],
    ["02", "PASSIVO", "0.00", "0.00", "7000.00", "7000.00"],
    ["02.1", "Capital", "0.00", "0.00", "7000.00", "7000.00"],
    ["03", "RECEITAS", "0.00", "0.00", "5000.00", "5000.00"],
    ["03.1", "Vendas", "0.00", "0.00", "5000.00", "5000.00"],
    ["06", "CONTAS DE DESTINACAO/APURACAO DE RESULTADO", "0.00", "2000.00", "0.00", "2000.00"],
    ["06.1", "IMPOSTO DE RENDA DA PESSOA JURIDICA - IRPJ", "0.00", "1400.00", "0.00", "1400.00"],
    ["06.2", "CONTRIBUICAO SOCIAL SOBRE O LUCRO LIQUIDO", "0.00", "600.00", "0.00", "600.00"],
  ];

  it("IRPJ e CSLL continuam na DRE (o nome do grupo não manda sozinho)", () => {
    const nomes = secoes(ler(comImpostos, "01/01/2022 a 31/12/2022")).map((s) => s.nome.toUpperCase());
    expect(nomes.join(" ")).toMatch(/IMPOSTO DE RENDA|CONTRIBUICAO SOCIAL/);
  });

  it("o resultado sai líquido dos impostos (5.000 − 2.000 = 3.000)", () => {
    expect(soma(ler(comImpostos, "01/01/2022 a 31/12/2022"))).toBeCloseTo(3000, 2);
  });

  it("mas DESTINAÇÃO do lucro (distribuição/dividendo) segue fora da DRE", () => {
    const comDistribuicao: L[] = [
      ...comImpostos.slice(0, 6),
      ["06", "CONTAS DE DESTINACAO/APURACAO DE RESULTADO", "0.00", "2000.00", "0.00", "2000.00"],
      ["06.1", "Distribuição de lucros", "0.00", "2000.00", "0.00", "2000.00"],
    ];
    const nomes = secoes(ler(comDistribuicao, "01/01/2022 a 31/12/2022")).map((s) => s.nome.toUpperCase());
    expect(nomes.join(" ")).not.toMatch(/DISTRIBUIC/);
  });
});

describe("ehNomeDeApuracao — régua conservadora", () => {
  it.each([
    "RESULTADO LÍQUIDO DO EXERCÍCIO",
    "Resultado do Exercício",
    "Resultado do Período",
    "CONTAS DE APURAÇÃO",
    "Apuração do Resultado",
    "CONTAS DE ENCERRAMENTO",
  ])("reconhece %s", (n) => expect(ehNomeDeApuracao(n)).toBe(true));

  it.each([
    "Resultado de Equivalência Patrimonial",
    "RESULTADO FINANCEIRO",
    "RESULTADO DE POSIÇÕES DO MERCADO",
    "Resultado Operacional do Exercício", // palavra própria no meio: é subtotal, não apuração
    "RESULTADO ACUMULADO",
    "Resultado Bruto",
  ])("NÃO confunde %s", (n) => expect(ehNomeDeApuracao(n)).toBe(false));
});

describe("P4 — DRE do exercício encerrado só é verde se reconciliar com o PL", () => {
  it("reconciliou: prova ok (receita 1.000 − custo 700 = PL +300)", () => {
    const p4 = ler(ENCERRADO).provas.dreEncerrada;
    expect(p4?.ok).toBe(true);
    expect(p4?.derivado).toBeCloseTo(300, 2);
    expect(p4?.declaradoPL).toBeCloseTo(300, 2);
  });

  it("transferência interna inflando os dois lados NÃO passa por provada", () => {
    // Mesmo PL (+300) e mesmos SALDOS (tudo zerado), mas o movimento carrega
    // R$ 5,7 milhões de transferência interna dos dois lados — a forma exata do
    // caso Belagro. A DRE derivada despenca e não reconcilia com o PL.
    const inflado: L[] = ENCERRADO.map((l) =>
      l[0] === "04.1" ? (["04.1", "CUSTOS", "0.00", "5700000.00", "5700000.00", "0.00"] as L) : l,
    );
    const p4 = ler(inflado).provas.dreEncerrada;
    expect(p4?.ok).toBe(false);
    expect(p4?.gap).toBeGreaterThan(p4!.limite);
  });

  it("balancete CORRENTE (não encerrado) não recebe a prova P4 — a DRE vem do saldo", () => {
    const corrente: L[] = [
      ["01", "ATIVO", "800.00", "1200.00", "800.00", "1200.00"],
      ["02", "PASSIVO", "800.00", "700.00", "1000.00", "900.00"],
      ["03", "RECEITAS", "0.00", "0.00", "1000.00", "1000.00"],
      ["04", "CUSTOS", "0.00", "700.00", "0.00", "700.00"],
    ];
    const c = ler(corrente, "01/05/2026 a 31/05/2026");
    expect(c.provas.exercicioEncerrado).toBe(false);
    expect(c.provas.dreEncerrada).toBeUndefined();
  });
});

/**
 * P0 — PARTIDA DOBRADA DAS LINHAS LIDAS (10/08/2026).
 *
 * A prova cruzada que não depende de total impresso: num balancete todo
 * lançamento tem os dois lados dentro do próprio documento. Ela mede o que o
 * sistema LEU — no corpus real reprovou 9 documentos que passavam verdes (a
 * WOLK tinha R$ 1.823,64 de diferença em 333 contas).
 */
describe("P0 — partida dobrada das linhas lidas", () => {
  // Documento minúsculo mas CONTABILMENTE real: cada lançamento tem os dois
  // lados dentro do próprio balancete (Σ débitos = Σ créditos = 2.800) e cada
  // linha fecha a própria equação (saldo atual = anterior ± movimento).
  const INTEGRO: L[] = [
    ["01", "ATIVO", "800.00", "1000.00", "800.00", "1000.00"],
    ["01.1", "Caixa", "800.00", "1000.00", "800.00", "1000.00"],
    ["02", "PASSIVO", "800.00", "800.00", "1000.00", "1000.00"],
    ["02.1", "Fornecedores", "800.00", "800.00", "1000.00", "1000.00"],
    ["03", "RECEITAS", "0.00", "0.00", "1000.00", "1000.00"],
    ["03.1", "Vendas", "0.00", "0.00", "1000.00", "1000.00"],
    ["04", "CUSTOS", "0.00", "1000.00", "0.00", "1000.00"],
    ["04.1", "Custo A", "0.00", "600.00", "0.00", "600.00"],
    ["04.2", "Custo B", "0.00", "400.00", "0.00", "400.00"],
  ];
  const prova = (linhas: L[]) => ler(linhas, "01/05/2026 a 31/05/2026").provas.partidaDobrada;

  it("documento íntegro: Σ débitos = Σ créditos nas folhas", () => {
    const p = prova(INTEGRO);
    expect(p.verificavel).toBe(true);
    expect(p.ok).toBe(true);
    expect(p.debitos).toBeCloseTo(p.creditos, 2);
    expect(p.debitos).toBeCloseTo(2800, 2);
  });

  it("LINHA PERDIDA no parse: reprova e mede a diferença exata", () => {
    const p = prova(INTEGRO.filter((l) => l[0] !== "04.2"));
    expect(p.ok).toBe(false);
    expect(Math.abs(p.delta)).toBeCloseTo(400, 2);
  });

  it("DÍGITO TROCADO numa coluna: reprova", () => {
    const p = prova(INTEGRO.map((l) => (l[0] === "03.1" ? (["03.1", "Vendas", "0.00", "0.00", "1900.00", "1900.00"] as L) : l)));
    expect(p.ok).toBe(false);
  });

  it("documento SÓ COM SALDO (sem movimento) fica NÃO VERIFICÁVEL, nunca verde", () => {
    const p = prova([
      ["01", "ATIVO", "1000.00", "0.00", "0.00", "1000.00"],
      ["02", "PASSIVO", "1000.00", "0.00", "0.00", "1000.00"],
    ]);
    expect(p.verificavel).toBe(false);
    expect(p.ok).toBe(false);
  });

  it("conta a soma sobre FOLHAS — sintética não entra duas vezes", () => {
    expect(prova(INTEGRO).folhas).toBe(5); // Caixa, Fornecedores, Vendas, Custo A, Custo B
  });
});
