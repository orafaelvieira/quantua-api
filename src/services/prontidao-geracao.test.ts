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

  /**
   * MUDOU EM 12/08/2026, e a mudança é de princípio: "todo problema ligado aos
   * documentos contábeis se resolve na conciliação do workspace; a geração do
   * IBR não pode ter atrito" (dono).
   *
   * O delta da composição foi PRESERVADO em "Outros" — nenhum valor se perdeu e
   * os totais continuam certos. É problema de ATRIBUIÇÃO de detalhe, e é um fato
   * do DOCUMENTO: aparece na aba Conciliação contábil, com o nó e a diferença,
   * onde o analista consegue agir. Bloquear a geração fazia o analista descobrir
   * isso DUAS TELAS depois de a seleção ter dito "tudo conciliado", e sem ação
   * disponível naquele ponto.
   */
  it("alerta de composição severidade ERRO → AVISA, não bloqueia (o delta está preservado)", () => {
    const d = base();
    d.alertasComposicao = [{ severidade: "info" }, { severidade: "erro" }];
    const r = avaliarProntidaoGeracao(d);
    expect(r.pronta).toBe(true);
    expect(r.pendencias.join(" ")).not.toMatch(/composição divergente/);
    expect(r.avisos.join(" ")).toMatch(/1 nó\(s\) com composição divergente/);
    expect(r.avisos.join(" ")).toMatch(/Conciliação contábil/);
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

/**
 * A MENSAGEM tem de casar com o documento que o analista tem na mão.
 * Flagrado em produção (IBR Budel, 03/08/2026): num IBR feito só de balancete o
 * gate mandava "reconciliar os subtotais declarados (Receita Líquida / Lucro
 * Bruto / Lucro Líquido)" — subtotais que balancete nenhum declara. O analista
 * sai procurando o que não existe.
 */
describe("mensagem do gate quando a reconciliação falha", () => {
  const divergente = (extra: Record<string, unknown>) => {
    const d = base() as any;
    d.validacao.reconciliacaoDRE = { verificada: true, ok: false };
    return { ...d, ...extra };
  };

  it("IBR só de BALANCETE: fala do fechamento do balancete, não de subtotal inexistente", () => {
    const texto = avaliarProntidaoGeracao(
      divergente({ balancetes: [{ docId: "d1", nome: "bal.pdf" }], declarados: [] }),
    ).pendencias.join(" ");
    expect(texto).toMatch(/balancete não fecha/i);
    expect(texto).not.toMatch(/subtotais declarados/i);
  });

  it("balancete lido por OCR: aponta o caminho prático (CSV/Excel)", () => {
    const texto = avaliarProntidaoGeracao(
      divergente({ balancetes: [{ docId: "d1", fonte: "ocr" }], declarados: [] }),
    ).pendencias.join(" ");
    expect(texto).toMatch(/OCR/);
    expect(texto).toMatch(/CSV\/Excel/i);
  });

  it("DRE de verdade com subtotais declarados: mantém a mensagem original", () => {
    const texto = avaliarProntidaoGeracao(
      divergente({ declarados: [{ conta: "Receita Líquida", valor: 100 }] }),
    ).pendencias.join(" ");
    expect(texto).toMatch(/subtotais declarados/i);
  });

  it("balancete SEM lista de declarados (campo ausente) também cai na mensagem certa", () => {
    const texto = avaliarProntidaoGeracao(
      divergente({ balancetes: [{ docId: "d1" }] }),
    ).pendencias.join(" ");
    expect(texto).toMatch(/balancete não fecha/i);
  });
});

/**
 * MENSAGEM COM ENDERECO (12/08/2026 — varredura adversarial). Todas estas
 * pendencias BLOQUEIAM a chamada mais cara do fluxo; se elas nao dizem O QUE
 * conferir, o analista trava sem ter o que fazer. A prova ja estava no mesmo
 * objeto e era descartada.
 */
describe("as pendências dizem o que conferir", () => {
  it("balanço que não fecha cita o período e a diferença que a validação calculou", () => {
    const d = base();
    d.validacao.equacaoPatrimonial = false;
    d.validacao.alertas = [{
      tipo: "erro", area: "Equação Patrimonial",
      mensagem: "Ativo Total (R$ 8,3 mi) ≠ Passivo Total (R$ 3,6 mi) em 31/12/2024",
      detalhes: "Diferença: R$ 4,7 mi (56,63%)",
    }];
    const r = avaliarProntidaoGeracao(d);
    const txt = r.pendencias.join(" ");
    expect(txt).toContain("31/12/2024");
    expect(txt).toContain("Diferença");
  });

  it("contas não classificadas são NOMEADAS, as maiores primeiro", () => {
    const d = base();
    d.naoMapeados = [
      { nome: "ADIANTAMENTOS DIVERSOS", valor: 1904756 },
      { nome: "Cafezinho", valor: 120 },
      { nome: "MUTUO SOCIOS", valor: 890000 },
    ];
    const r = avaliarProntidaoGeracao(d);
    const txt = r.pendencias.join(" ");
    expect(txt).toContain("3 conta(s)");
    expect(txt).toContain("ADIANTAMENTOS DIVERSOS");
    expect(txt.indexOf("ADIANTAMENTOS DIVERSOS")).toBeLessThan(txt.indexOf("Cafezinho"));
  });

  it("documento faltando aponta a ação que EXISTE (aba Escopo), não 'suba e reprocesse'", () => {
    const d = base();
    d.dre = [];
    const txt = avaliarProntidaoGeracao(d).pendencias.join(" ");
    expect(txt).toContain("aba Escopo");
    expect(txt).not.toContain("reprocesse");
  });

  it("composição do TOPO tem nome próprio — não se confunde com a prova de nó", () => {
    const d = base();
    d.validacao.composicaoAtivo = false;
    const txt = avaliarProntidaoGeracao(d).pendencias.join(" ");
    expect(txt).toContain("não reproduz o TOTAL impresso");
    expect(txt).not.toContain("alertas de composição na auditoria");
  });
});
