import { describe, it, expect } from "vitest";
import { avaliarProntidaoGeracao } from "./prontidao-geracao";

// Fixtures no SHAPE DE PRODUÇÃO (dadosEstruturados v2, como o /process persiste) —
// lição da auditoria: testar com a forma que a rota constrói, não a idealizada.
const bpOk = [
  { classificacao: "AF", conta: "Caixa e Equivalentes de Caixa", nivel: 2, valores: { "2023": 100_000 } },
  { classificacao: "PO", conta: "Fornecedores - CP", nivel: 2, valores: { "2023": 100_000 } },
];
const dreOk = [
  { conta: "Receita Líquida", valores: { "2023": 500_000 } },
  { conta: "Lucro Líquido", valores: { "2023": 50_000 } },
];
const validacaoLimpa = {
  equacaoPatrimonial: true,
  composicaoAtivo: true,
  composicaoPassivo: true,
  reconciliacaoDRE: { verificada: true, ok: true },
};
const base = () => ({
  version: 2,
  bp: bpOk.map((l) => ({ ...l })),
  dre: dreOk.map((l) => ({ ...l })),
  validacao: { ...validacaoLimpa, reconciliacaoDRE: { ...validacaoLimpa.reconciliacaoDRE } },
  naoMapeados: [] as unknown[],
  alertasComposicao: [] as unknown[],
});

describe("avaliarProntidaoGeracao — a régua única do gate", () => {
  it("extração limpa e completa → pronta, sem pendências", () => {
    const r = avaliarProntidaoGeracao(base());
    expect(r.pronta).toBe(true);
    expect(r.pendencias).toEqual([]);
  });

  it("SEM DRE importada → bloqueia com pendência explícita (caso real do usuário)", () => {
    const d = base();
    d.dre = [];
    const r = avaliarProntidaoGeracao(d);
    expect(r.pronta).toBe(false);
    expect(r.pendencias.join(" ")).toMatch(/Nenhuma DRE/i);
  });

  it("SEM Balanço importado → bloqueia com pendência explícita", () => {
    const d = base();
    d.bp = [];
    const r = avaliarProntidaoGeracao(d);
    expect(r.pronta).toBe(false);
    expect(r.pendencias.join(" ")).toMatch(/Nenhum Balanço/i);
  });

  it("DRE presente mas só com zeros = ausente (não engana a régua)", () => {
    const d = base();
    d.dre = [{ conta: "Receita Líquida", valores: { "2023": 0 } }];
    expect(avaliarProntidaoGeracao(d).pronta).toBe(false);
  });

  it("equação patrimonial aberta → bloqueia", () => {
    const d = base();
    (d.validacao as any).equacaoPatrimonial = false;
    const r = avaliarProntidaoGeracao(d);
    expect(r.pronta).toBe(false);
    expect(r.pendencias.join(" ")).toMatch(/não fecha/i);
  });

  it("contas não classificadas COM VALOR → bloqueia com contagem (distinta por nome)", () => {
    const d = base();
    d.naoMapeados = [
      { nome: "ADIANTAMENTOS DIVERSOS", grupo: "Passivo Circulante", valor: 1_904_756, periodo: "2023", tipo: "BP" },
      { nome: "ADIANTAMENTOS DIVERSOS", grupo: "Passivo Circulante", valor: 876_138, periodo: "2022", tipo: "BP" },
      { nome: "RECEITAS DIFERIDAS", grupo: "Passivo Não Circulante", valor: 71_748, periodo: "2023", tipo: "BP" },
    ];
    const r = avaliarProntidaoGeracao(d);
    expect(r.pronta).toBe(false);
    expect(r.pendencias.join(" ")).toMatch(/2 conta\(s\) não classificada/);
  });

  it("não classificada com valor ZERO não bloqueia (sem materialidade)", () => {
    const d = base();
    d.naoMapeados = [{ nome: "CONTA VAZIA", grupo: "Ativo Circulante", valor: 0, periodo: "2023", tipo: "BP" }];
    expect(avaliarProntidaoGeracao(d).pronta).toBe(true);
  });

  it("DRE VERIFICADA e divergente → bloqueia; NÃO-verificável → passa com AVISO", () => {
    const div = base();
    (div.validacao as any).reconciliacaoDRE = { verificada: true, ok: false };
    expect(avaliarProntidaoGeracao(div).pronta).toBe(false);

    const semDecl = base();
    (semDecl.validacao as any).reconciliacaoDRE = { verificada: false, ok: false };
    const r = avaliarProntidaoGeracao(semDecl);
    expect(r.pronta).toBe(true);
    expect(r.avisos.join(" ")).toMatch(/não traz subtotais/i);
  });

  it("alerta de composição severidade ERRO → bloqueia; info não bloqueia", () => {
    const d = base();
    d.alertasComposicao = [{ severidade: "info" }, { severidade: "erro" }];
    const r = avaliarProntidaoGeracao(d);
    expect(r.pronta).toBe(false);
    expect(r.pendencias.join(" ")).toMatch(/1 nó\(s\) com composição divergente/);
  });

  it("análise LEGADA (sem validação persistida) → libera com aviso (não brica IBRs antigos)", () => {
    const r = avaliarProntidaoGeracao({ bp: bpOk, dre: dreOk }); // sem version/validacao
    expect(r.pronta).toBe(true);
    expect(r.avisos.length).toBeGreaterThan(0);
  });

  it("fluxo legado: unmatchedAccounts (valores por período) também conta", () => {
    const d = base();
    delete (d as any).naoMapeados;
    (d as any).unmatchedAccounts = [{ conta: "OUTRAS CONTAS", valores: { "2023": 5_000 } }];
    const r = avaliarProntidaoGeracao(d);
    expect(r.pronta).toBe(false);
    expect(r.pendencias.join(" ")).toMatch(/1 conta\(s\)/);
  });
});
