import { describe, it, expect } from "vitest";
import { resolverCascataDicionario, prioridadeEscopo, whereCascataDicionario, situacaoDaCascata } from "./dicionario-escopo";

const global_ = (nome: string, destino: string, grupo = "Ativo Circulante") =>
  ({ nomeOriginal: nome, contaDestino: destino, grupoConta: grupo, tipo: "BP", userId: null, companyId: null });
const workspace = (nome: string, destino: string, grupo = "Ativo Circulante") =>
  ({ nomeOriginal: nome, contaDestino: destino, grupoConta: grupo, tipo: "BP", userId: "u1", companyId: null });
const empresa = (nome: string, destino: string, grupo = "Ativo Circulante", companyId = "c1") =>
  ({ nomeOriginal: nome, contaDestino: destino, grupoConta: grupo, tipo: "BP", userId: "u1", companyId });

describe("prioridadeEscopo", () => {
  it("global < workspace < empresa", () => {
    expect(prioridadeEscopo(global_("x", "y"))).toBe(0);
    expect(prioridadeEscopo(workspace("x", "y"))).toBe(1);
    expect(prioridadeEscopo(empresa("x", "y"))).toBe(2);
  });
});

describe("resolverCascataDicionario", () => {
  it("entrada de EMPRESA vence workspace e global para a mesma conta", () => {
    const r = resolverCascataDicionario([
      global_("Bancos", "Caixa e Equivalentes de Caixa"),
      workspace("Bancos", "Aplicações Financeiras - LP"),
      empresa("Bancos", "Contas a Receber - CP"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].contaDestino).toBe("Contas a Receber - CP");
  });

  it("workspace vence global; ordem de chegada não importa", () => {
    const r = resolverCascataDicionario([
      workspace("Bancos", "B"),
      global_("Bancos", "A"),
    ]);
    expect(r[0].contaDestino).toBe("B");
  });

  it("contas de grupos diferentes NÃO colidem (chave inclui grupoConta)", () => {
    const r = resolverCascataDicionario([
      global_("Empréstimos", "Empréstimos e Financiamentos - CP", "Passivo Circulante"),
      global_("Empréstimos", "Empréstimos e Financiamentos - LP", "Passivo Não Circulante"),
    ]);
    expect(r).toHaveLength(2);
  });

  it("match de nome é case-insensitive", () => {
    const r = resolverCascataDicionario([
      global_("BANCOS", "A"),
      empresa("bancos", "B"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].contaDestino).toBe("B");
  });

  it("filtra por tipo quando pedido (BP não vaza para DRE)", () => {
    const r = resolverCascataDicionario([
      global_("Receita de Vendas", "Receita Bruta"),
      { ...global_("Receita de Vendas", "Receita Bruta"), tipo: "DRE" },
    ], "DRE");
    expect(r).toHaveLength(1);
    expect(r[0].tipo).toBe("DRE");
  });

  // Regressão (18/07/2026): na DRE o grupoConta ESPELHA o destino, então empresa
  // e global viravam chaves diferentes e as DUAS sobreviviam — a blindagem
  // contextual do fold preferia a global por bloco e descartava a correção
  // explícita da empresa ("alterei a classificação e ele não respeitou").
  it("DRE: entrada da EMPRESA vence a global do mesmo nome, mesmo com grupoConta diferente", () => {
    const dre = <T extends { tipo: string }>(e: T): T => ({ ...e, tipo: "DRE" });
    const r = resolverCascataDicionario([
      dre(global_("Perdas Commodities", "Outras Despesas Operacionais", "Outras Despesas Operacionais")),
      dre(empresa("Perdas Commodities", "Outras Despesas Não Operacionais", "Outras Despesas Não Operacionais")),
    ], "DRE");
    expect(r).toHaveLength(1);
    expect(r[0].contaDestino).toBe("Outras Despesas Não Operacionais");
    expect(r[0].companyId).toBe("c1");
  });

  it("BP: override da empresa em UM grupo não derruba a global de OUTRO grupo", () => {
    const r = resolverCascataDicionario([
      global_("Instituições Financeiras", "Empréstimos e Financiamentos - LP", "Passivo Não Circulante"),
      global_("Instituições Financeiras", "Empréstimos e Financiamentos - CP", "Passivo Circulante"),
      empresa("Instituições Financeiras", "Outros Passivos Circulantes", "Passivo Circulante"),
    ], "BP");
    expect(r).toHaveLength(2);
    expect(r.find((e) => e.grupoConta === "Passivo Não Circulante")?.contaDestino).toBe("Empréstimos e Financiamentos - LP");
    expect(r.find((e) => e.grupoConta === "Passivo Circulante")?.contaDestino).toBe("Outros Passivos Circulantes");
  });
});

describe("whereCascataDicionario", () => {
  it("sem empresa: só global + workspace", () => {
    const w = whereCascataDicionario(["u1", "u2"]);
    expect(w.OR).toHaveLength(2);
    expect(w.OR[0]).toEqual({ userId: null, companyId: null });
    expect(w.OR[1]).toEqual({ userId: { in: ["u1", "u2"] }, companyId: null });
  });

  it("com empresa: inclui as entradas DAQUELA empresa (e só dela)", () => {
    const w = whereCascataDicionario(["u1"], "c1");
    expect(w.OR).toHaveLength(3);
    expect(w.OR[2]).toEqual({ companyId: "c1" });
  });
});

/**
 * O VETO NÃO PODE VENCER A CLASSIFICAÇÃO (11/08/2026 — caso Dunamys).
 *
 * "Classifiquei a conta mas o ✗ não sumiu": a conta estava marcada como
 * IGNORAR no dicionário GLOBAL; o analista classificou na EMPRESA; como no BP
 * a chave inclui o grupoConta, as duas entradas sobreviviam — e
 * `isContaIgnorada` casa só pelo nome, então o veto global continuava tirando
 * R$ 150,6 mil do balanço, sem caminho de volta pela tela.
 */
describe("ignorar é veto — e perde para classificação mais específica", () => {
  const global = (nome: string, destino: string, grupo = "Patrimônio Líquido") =>
    ({ nomeOriginal: nome, contaDestino: destino, grupoConta: grupo, userId: null, companyId: null, tipo: "BP" });
  const daEmpresa = (nome: string, destino: string, grupo = "Patrimônio Líquido") =>
    ({ nomeOriginal: nome, contaDestino: destino, grupoConta: grupo, userId: "u1", companyId: "c1", tipo: "BP" });

  it("classificação da EMPRESA derruba o ignorar GLOBAL do mesmo nome", () => {
    const r = resolverCascataDicionario(
      [global("Lucros/Prejuízos Acumulados", "__IGNORAR__"), daEmpresa("Lucros/Prejuízos Acumulados", "Lucros/Prejuízos Acumulados")],
      "BP",
    );
    expect(r.some((e) => e.contaDestino === "__IGNORAR__")).toBe(false);
    expect(r.some((e) => e.contaDestino === "Lucros/Prejuízos Acumulados")).toBe(true);
  });

  it("mesmo com grupoConta DIFERENTE (era o que criava duas chaves)", () => {
    const r = resolverCascataDicionario(
      [global("Lucros/Prejuízos Acumulados", "__IGNORAR__", "Outros"), daEmpresa("Lucros/Prejuízos Acumulados", "Lucros/Prejuízos Acumulados")],
      "BP",
    );
    expect(r.some((e) => e.contaDestino === "__IGNORAR__")).toBe(false);
  });

  it("ignorar SOZINHO continua valendo (subtotal duplicado segue fora)", () => {
    const r = resolverCascataDicionario([global("TOTAL DO ATIVO", "__IGNORAR__")], "BP");
    expect(r.some((e) => e.contaDestino === "__IGNORAR__")).toBe(true);
  });

  it("classificação em OUTRA conta não derruba o ignorar desta", () => {
    const r = resolverCascataDicionario(
      [global("TOTAL DO ATIVO", "__IGNORAR__"), daEmpresa("Caixa Geral", "Caixa e Equivalentes de Caixa", "Ativo Circulante")],
      "BP",
    );
    expect(r.some((e) => e.contaDestino === "__IGNORAR__")).toBe(true);
  });
});

describe("situacaoDaCascata — quem vale e quem é sombra", () => {
  const linha = (id: string, nome: string, destino: string, escopo: "g" | "u" | "e", extra: Record<string, unknown> = {}) => ({
    id, nomeOriginal: nome, contaDestino: destino, grupoConta: "Ativo Circulante", tipo: "BP",
    userId: escopo === "g" ? null : "u1",
    companyId: escopo === "e" ? "c1" : null,
    ...extra,
  });

  it("mesmo destino em duas camadas: a de cima vale e é REDUNDANTE; a de baixo fica sem efeito", () => {
    const s = situacaoDaCascata([
      linha("g1", "Autônomos", "Serviços de Terceiros", "g"),
      linha("u1", "Autônomos", "Serviços de Terceiros", "u"),
    ]);
    expect(s.get("u1")).toEqual({ emUso: true, sobrepostaPor: null, redundante: true });
    expect(s.get("g1")).toEqual({ emUso: false, sobrepostaPor: "Usuário", redundante: false });
  });

  it("destino DIFERENTE não é redundante — o override muda número", () => {
    const s = situacaoDaCascata([
      linha("g1", "Autônomos", "Serviços de Terceiros", "g"),
      linha("e1", "Autônomos", "Despesas com Pessoal", "e"),
    ]);
    expect(s.get("e1")!.redundante).toBe(false);
    expect(s.get("g1")).toEqual({ emUso: false, sobrepostaPor: "Empresa", redundante: false });
  });

  it("entrada única vale e não é redundante", () => {
    const s = situacaoDaCascata([linha("g1", "Caixa", "Caixa e Equivalentes de Caixa", "g")]);
    expect(s.get("g1")).toEqual({ emUso: true, sobrepostaPor: null, redundante: false });
  });

  it("cancelada fica fora do jogo: não vale e não sombreia ninguém", () => {
    const s = situacaoDaCascata([
      linha("g1", "Autônomos", "Serviços de Terceiros", "g"),
      linha("u1", "Autônomos", "Despesas com Pessoal", "u", { revisao: "cancelada" }),
    ]);
    expect(s.get("u1")).toEqual({ emUso: false, sobrepostaPor: null, redundante: false });
    expect(s.get("g1")!.emUso).toBe(true);
  });

  it("BP e DRE são dicionários distintos — mesmo nome nos dois, ambos valem", () => {
    const s = situacaoDaCascata([
      linha("b1", "Fretes", "Fornecedores", "g"),
      { ...linha("d1", "Fretes", "Despesas com Vendas", "g"), tipo: "DRE" },
    ]);
    expect(s.get("b1")!.emUso).toBe(true);
    expect(s.get("d1")!.emUso).toBe(true);
  });
});

describe("situacaoDaCascata — DRE aponta o culpado mesmo com grupo diferente", () => {
  it("na DRE o grupo espelha o destino: a sombra ainda sabe quem manda", () => {
    const dre = (id: string, destino: string, escopo: "g" | "e") => ({
      id, nomeOriginal: "Fretes", contaDestino: destino, grupoConta: destino, tipo: "DRE",
      userId: escopo === "g" ? null : "u1", companyId: escopo === "e" ? "c1" : null,
    });
    const s = situacaoDaCascata([dre("g1", "Despesas com Vendas", "g"), dre("e1", "Custo dos Produtos Vendidos", "e")]);
    expect(s.get("e1")!.emUso).toBe(true);
    expect(s.get("g1")).toEqual({ emUso: false, sobrepostaPor: "Empresa", redundante: false });
  });
});

describe("cascata ignora o código do plano — a entrada velha e a nova são a MESMA conta", () => {
  const linha = (id: string, nome: string, destino: string, escopo: "g" | "e") => ({
    id, nomeOriginal: nome, contaDestino: destino, grupoConta: "Outras Receitas Operacionais", tipo: "DRE",
    userId: escopo === "g" ? null : "u1", companyId: escopo === "e" ? "c1" : null,
  });

  it("mesma conta com e sem código colapsa numa vencedora só — nas DUAS ordens", () => {
    const velha = linha("v", "4.03.02.01 PROCESSO 000014.0316758/2020", "Outras Receitas Operacionais", "e");
    const nova = linha("n", "PROCESSO 000014.0316758/2020", "Outras Receitas Não Operacionais", "e");
    const a = resolverCascataDicionario([velha, nova], "DRE");
    const b = resolverCascataDicionario([nova, velha], "DRE");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // Vence a LIMPA, venha na ordem que vier — antes decidia a ordem do findMany.
    expect(a[0].id).toBe("n");
    expect(b[0].id).toBe("n");
  });

  it("escopo maior continua vencendo o nome limpo de escopo menor", () => {
    const globalLimpa = linha("g", "PROCESSO 000014.0316758/2020", "Outras Receitas Operacionais", "g");
    const empresaComCodigo = linha("e", "4.03.02.01 PROCESSO 000014.0316758/2020", "Outras Receitas Não Operacionais", "e");
    const r = resolverCascataDicionario([globalLimpa, empresaComCodigo], "DRE");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("e");
  });

  it("a tela marca a entrada com código como sem efeito", () => {
    const s = situacaoDaCascata([
      { ...linha("v", "4.03.02.01 PROCESSO 000014.0316758/2020", "Outras Receitas Operacionais", "e") },
      { ...linha("n", "PROCESSO 000014.0316758/2020", "Outras Receitas Operacionais", "e") },
    ]);
    expect(s.get("n")!.emUso).toBe(true);
    expect(s.get("v")!.emUso).toBe(false);
  });
});

/**
 * O SINAL "(-)" É CONTA REDUTORA, NÃO SUJEIRA (13/08/2026 — regressão que a
 * revisão adversarial pegou no mesmo dia em que subiu).
 */
describe("cascata preserva a conta redutora", () => {
  const glob = (id: string, nome: string, destino: string) => ({
    id, nomeOriginal: nome, contaDestino: destino, grupoConta: "Ativo Não Circulante",
    tipo: "BP", userId: null, companyId: null,
  });

  it('"(-) Móveis E Utensílios" e "Móveis e Utensílios" são contas DIFERENTES', () => {
    const r = resolverCascataDicionario([
      glob("dep", "(-) Moveis E Utensilios", "(-) Depreciação"),
      glob("ativo", "Moveis e Utensilios", "Imobilizado"),
    ], "BP");
    expect(r).toHaveLength(2);
    expect(r.map((e) => e.contaDestino).sort()).toEqual(["(-) Depreciação", "Imobilizado"]);
  });

  it("o CÓDIGO do plano continua colapsando — é sujeira, não significado", () => {
    const r = resolverCascataDicionario([
      glob("v", "1.02.03 Moveis e Utensilios", "Imobilizado"),
      glob("n", "Moveis e Utensilios", "Imobilizado"),
    ], "BP");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("n");
  });

  it("código E sinal juntos: colapsa só o código, o sinal segue distinguindo", () => {
    const r = resolverCascataDicionario([
      glob("a", "1.02.09 (-) Moveis E Utensilios", "(-) Depreciação"),
      glob("b", "(-) Moveis E Utensilios", "(-) Depreciação"),
      glob("c", "Moveis e Utensilios", "Imobilizado"),
    ], "BP");
    expect(r).toHaveLength(2);
  });
});
