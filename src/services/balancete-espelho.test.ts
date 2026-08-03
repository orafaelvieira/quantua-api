/**
 * GRUPO-ESPELHO: raiz de circuito fechado não é demonstração financeira.
 *
 * Caso Budel (03/08/2026, produção). O plano de contas traz "4 CENTRO DE
 * CUSTOS", que espelha os custos operacionais e devolve tudo por uma
 * contrapartida "TRANSFERÊNCIAS". A raiz vale 0,00 nos dois retratos, então o
 * FECHAMENTO PASSAVA — e a DRE saía com o custo dobrado e uma receita de
 * R$ 34.497.458,97 que não existe (viraram "Outras Receitas Operacionais
 * 54.361.198" na tela; a verdade do grupo 33 é R$ 7.015,20).
 *
 * Os três cenários abaixo são os contraexemplos que a revisão adversarial
 * levantou — cada um justifica uma das quatro condições do detector.
 */
import { describe, it, expect } from "vitest";
import { parseBalanceteMatriz } from "./balancete-tabular";
import { converterBalancete } from "./balancete-conversao";

const CAB = ["Classificação", "Nome da conta contábil", "Saldo anterior", "Débito", "Crédito", "Saldo atual"];
const ler = (linhas: Array<[string, string, string, string, string, string]>) =>
  converterBalancete(parseBalanceteMatriz([["01/07/2015 a 31/07/2015"], CAB, ...linhas] as any));
const secoes = (c: any) => {
  const arv: any = c.arvoreDRE ?? {};
  const v: any = Object.values(arv)[0] ?? [];
  const lista = Array.isArray(v) ? v : (v?.secoes ?? []);
  const nomes: string[] = [];
  const anda = (its: any[]) => { for (const i of its) { nomes.push(String(i.nome)); if (i.filhos?.length) anda(i.filhos); } };
  anda(lista);
  return nomes;
};

// Ativo 1.200 − Passivo 900 = 300 = lucro (receita 1.000 − custo 700).
const COMUM: Array<[string, string, string, string, string, string]> = [
  ["1", "ATIVO", "1000.00", "500.00", "300.00", "1200.00"],
  ["11", "CIRCULANTE", "600.00", "500.00", "300.00", "800.00"],
  ["17", "NAO CIRCULANTE", "400.00", "0.00", "0.00", "400.00"],
  ["2", "PASSIVO", "1000.00", "200.00", "100.00", "900.00"],
  ["21", "CIRCULANTE", "1000.00", "200.00", "100.00", "900.00"],
  ["3", "RESULTADO", "0.00", "700.00", "1000.00", "300.00"],
  ["31", "RECEITAS", "0.00", "0.00", "1000.00", "1000.00"],
  ["32", "CUSTO DOS BENS E SERVICOS VENDIDOS", "0.00", "700.00", "0.00", "700.00"],
];
/** Estrutura da raiz 4 do Budel: centros de custo + contrapartida que devolve. */
const ESPELHO: Array<[string, string, string, string, string, string]> = [
  ["4", "CENTRO DE CUSTOS", "0.00", "700.00", "700.00", "0.00"],
  ["41", "CUSTOS DIRETOS E INDIRETOS", "0.00", "700.00", "0.00", "700.00"],
  ["4101", "CUSTO DO PESSOAL APLICADO NA PRODUCAO", "0.00", "700.00", "0.00", "700.00"],
  ["4199", "CUSTOS DOS BENS E SERVICOS VENDIDOS", "0.00", "0.00", "700.00", "-700.00"],
  ["419999", "TRANSFERENCIAS", "0.00", "0.00", "700.00", "-700.00"],
];

describe("raiz-espelho fica fora da DRE sem mexer em total nenhum", () => {
  const controle = ler(COMUM);
  const comEspelho = ler([...COMUM, ...ESPELHO]);

  it("nenhum total se move — é o que garante que a prova não enfraquece", () => {
    expect(comEspelho.resultadoAcumulado).toBe(controle.resultadoAcumulado);
    expect(comEspelho.provas.fechamento.delta).toBe(controle.provas.fechamento.delta);
    expect(comEspelho.provas.fechamento.ok).toBe(true);
  });

  it("a DRE não ganha o custo dobrado nem a receita da contrapartida", () => {
    expect(secoes(controle)).toEqual(secoes(comEspelho));
    expect(secoes(comEspelho).join(" ")).not.toMatch(/TRANSFERENCIAS|CUSTO DO PESSOAL/);
  });

  it("o dinheiro excluído aparece em aviso auditável, com o valor", () => {
    const aviso = comEspelho.avisos.find((a) => a.includes("CIRCUITO FECHADO"));
    expect(aviso).toBeDefined();
    expect(aviso).toContain("CENTRO DE CUSTOS");
    expect(aviso).toMatch(/1\.400,00|700,00/); // movimento que passou pelo grupo
  });

  it("exercicioEncerrado NÃO vira true por causa do espelho (trocaria o regime da DRE)", () => {
    expect(comEspelho.provas.exercicioEncerrado).toBe(false);
    expect(controle.provas.exercicioEncerrado).toBe(false);
  });
});

describe("os três contraexemplos que delimitam a regra", () => {
  it("EXERCÍCIO ENCERRADO não é espelho: cada conta zera sozinha, não há 2 contas vivas", () => {
    const encerrado = ler([
      ["1", "ATIVO", "1000.00", "0.00", "0.00", "1000.00"],
      ["2", "PASSIVO", "1000.00", "0.00", "0.00", "1000.00"],
      ["3", "RESULTADO", "0.00", "700.00", "700.00", "0.00"],
      ["31", "RECEITAS", "0.00", "700.00", "700.00", "0.00"],
      ["32", "CUSTOS", "0.00", "700.00", "700.00", "0.00"],
    ]);
    expect(encerrado.avisos.join(" ")).not.toMatch(/CIRCUITO FECHADO/);
    expect(encerrado.provas.exercicioEncerrado).toBe(true);
  });

  it("raiz que zera mas cujas folhas NÃO somam zero é defeito de leitura: continua na prova", () => {
    // O saldo da raiz foi lido como 0,00 mas as folhas somam 100 — um dígito
    // errado dentro do grupo. Excluí-lo esconderia o erro; ele tem de ficar.
    const quebrado = ler([
      ...COMUM,
      ["4", "CENTRO DE CUSTOS", "0.00", "700.00", "700.00", "0.00"],
      ["41", "CUSTO DO PESSOAL", "0.00", "800.00", "0.00", "800.00"],
      ["4199", "TRANSFERENCIAS", "0.00", "0.00", "700.00", "-700.00"],
    ]);
    expect(quebrado.avisos.join(" ")).not.toMatch(/CIRCUITO FECHADO/);
    expect(quebrado.provas.fechamento.ok).toBe(false); // o motor acusa em vez de esconder
  });

  it("período SEM movimento não some: sem movimento não há espelho", () => {
    const parado = ler([
      ["1", "ATIVO", "1000.00", "0.00", "0.00", "1000.00"],
      ["2", "PASSIVO", "1000.00", "0.00", "0.00", "1000.00"],
      ["3", "RESULTADO", "0.00", "0.00", "0.00", "0.00"],
      ["31", "RECEITAS", "0.00", "0.00", "0.00", "0.00"],
      ["32", "CUSTOS", "0.00", "0.00", "0.00", "0.00"],
    ]);
    expect(parado.avisos.join(" ")).not.toMatch(/CIRCUITO FECHADO/);
  });
});

/**
 * O aviso tem de existir COMO DADO, não só como texto solto num array que
 * ninguém lê. A revisão adversarial mostrou que um alerta empilhado no fim do
 * laço de `aplicarProvasBalancete` nunca rodaria para um balancete cujo
 * fechamento PASSA — e é exatamente esse o caso do espelho.
 */
describe("gruposExcluidos é dado estruturado, não texto", () => {
  it("traz nome, número de contas e movimento do grupo deixado de fora", () => {
    const c = ler([...COMUM, ...ESPELHO]);
    expect(c.gruposExcluidos).toHaveLength(1);
    expect(c.gruposExcluidos[0].nome).toBe("CENTRO DE CUSTOS");
    expect(c.gruposExcluidos[0].contas).toBeGreaterThanOrEqual(2);
    expect(c.gruposExcluidos[0].movimento).toBeGreaterThan(0);
  });

  it("documento sem espelho devolve lista vazia (nunca undefined)", () => {
    expect(ler(COMUM).gruposExcluidos).toEqual([]);
  });
});

/**
 * O FALSO POSITIVO QUE A REVISÃO ADVERSARIAL ENCONTROU (03/08/2026).
 *
 * Com apenas "≥2 contas vivas", uma reclassificação de R$ 0,06 entre duas
 * contas irmãs num balancete de ENCERRAMENTO fazia a raiz de resultado inteira
 * (544 folhas, R$ 834 milhões de DRE no documento real
 * "Balancete de encerramento 2023.xlsx") ser lida como circuito fechado: a DRE
 * ia a ZERO seções, com selo VERDE dizendo "fechamento provado ao centavo".
 * Seis centavos apagavam a demonstração inteira.
 *
 * A condição que faltava: as contas vivas têm de CARREGAR o movimento do grupo.
 */
describe("encerramento com resíduo de centavos NÃO é espelho", () => {
  // Encerramento: tudo zerado, exceto duas contas irmãs com 0,06 de resíduo
  // (reclassificação pós-encerramento). O movimento do grupo é de milhões.
  const encerradoComResiduo: Array<[string, string, string, string, string, string]> = [
    ["1", "ATIVO", "1000.00", "0.00", "0.00", "1000.00"],
    ["2", "PASSIVO", "1000.00", "0.00", "0.00", "1000.00"],
    ["3", "CONTAS DE RESULTADO", "0.00", "5000000.00", "5000000.00", "0.00"],
    ["31", "RECEITAS", "0.00", "5000000.00", "5000000.00", "0.00"],
    ["3101", "RECEITA A", "0.00", "2500000.00", "2500000.00", "0.00"],
    ["3102", "RECEITA B", "0.00", "2500000.06", "2500000.00", "0.06"],
    ["3103", "RECEITA C", "0.00", "0.00", "0.06", "-0.06"],
  ];

  it("a razão saldo vivo / movimento é ínfima — o grupo permanece na DRE", () => {
    const c = ler(encerradoComResiduo);
    expect(c.gruposExcluidos).toEqual([]);
    expect(c.avisos.join(" ")).not.toMatch(/CIRCUITO FECHADO/);
  });

  it("a DRE NÃO fica vazia (era o estrago: 6 centavos apagavam R$ 834 milhões)", () => {
    expect(secoes(ler(encerradoComResiduo)).length).toBeGreaterThan(0);
  });

  it("no espelho de verdade as contas vivas carregam o movimento — segue excluído", () => {
    const c = ler([...COMUM, ...ESPELHO]);
    expect(c.gruposExcluidos).toHaveLength(1);
  });
});
