import { describe, it, expect } from "vitest";
import { anoTransicao, aliquotasNovasDoAno, calcularImpostosReforma, fatorCategoria } from "./reforma-tributaria";
import type { BlocoModelo } from "./model-engine";
import { calcularModelo } from "./model-engine";

const CFG = { aliqCbsRef: 0.088, aliqIbsRef: 0.177, pctCustosCreditaveis: 1, capexCredita: true } as const;

describe("cronograma de transição (LC 214, arts. 343-364, 501, 508)", () => {
  it("2026 é neutro: sem CBS/IBS efetivos, PIS/COFINS e ICMS/ISS cheios", () => {
    const t = anoTransicao(2026);
    expect(t.pisCofinsVigente).toBe(true);
    expect(t.fatorIcmsIss).toBe(1);
    expect(aliquotasNovasDoAno(2026, CFG).tVenda).toBe(0);
  });

  it("2027-2028: CBS de referência − 0,1 p.p. + IBS 0,1%; PIS/COFINS extintos; ICMS/ISS cheios", () => {
    const { tVenda } = aliquotasNovasDoAno(2027, CFG);
    expect(tVenda).toBeCloseTo(0.088 - 0.001 + 0.001, 10);
    const t = anoTransicao(2028);
    expect(t.pisCofinsVigente).toBe(false);
    expect(t.fatorIcmsIss).toBe(1);
  });

  it("2029-2032: IBS em 10/20/30/40% da referência; ICMS/ISS caem na mesma proporção", () => {
    expect(anoTransicao(2029).fracaoIbs).toBe(0.1);
    expect(anoTransicao(2029).fatorIcmsIss).toBe(0.9);
    expect(anoTransicao(2032).fracaoIbs).toBe(0.4);
    expect(anoTransicao(2032).fatorIcmsIss).toBe(0.6);
    expect(aliquotasNovasDoAno(2030, CFG).tVenda).toBeCloseTo(0.088 + 0.177 * 0.2, 10);
  });

  it("2033+: sistema pleno — CBS + IBS integrais, ICMS/ISS extintos", () => {
    const t = anoTransicao(2033);
    expect(t.fatorIcmsIss).toBe(0);
    expect(aliquotasNovasDoAno(2035, CFG).tVenda).toBeCloseTo(0.088 + 0.177, 10);
  });

  it("categorias: reduções de 30/60/80/100% (arts. 127-149)", () => {
    expect(fatorCategoria("reducao30")).toBe(0.7);
    expect(fatorCategoria("reducao60")).toBeCloseTo(0.4, 10);
    expect(fatorCategoria("reducao80")).toBeCloseTo(0.2, 10);
    expect(fatorCategoria("zero")).toBe(0);
    // redução na VENDA não corta o crédito da COMPRA (art. 47 §6º)
    const r = aliquotasNovasDoAno(2033, { ...CFG, categoria: "reducao60" });
    expect(r.tVenda).toBeCloseTo((0.088 + 0.177) * 0.4, 10);
    expect(r.tCompra).toBeCloseTo(0.088 + 0.177, 10);
  });
});

describe("calcularImpostosReforma", () => {
  const meses = (ano: number) => Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, "0")}`);
  const serieConst = (ms: string[], v: number) => Object.fromEntries(ms.map((m) => [m, v]));

  it("2026: carga = tributação atual (teste neutro — Decreto 12.955, arts. 464/583)", () => {
    const ms = meses(2026);
    const r = calcularImpostosReforma({
      meses: ms, receita: serieConst(ms, 100_000), comprasCreditaveis: serieConst(ms, 40_000),
      capex: {}, cfg: { ...CFG }, pisCofinsPct: 0.0365, icmsIssPct: 0.05,
    });
    expect(r.impostosConsumo[ms[0]]).toBeCloseTo(100_000 * (0.0365 + 0.05), 6);
    expect(r.debitoNovo[ms[0]]).toBe(0);
  });

  it("2033 pleno: débito por fora − crédito das compras; conta fecha na mão", () => {
    const ms = meses(2033);
    const r = calcularImpostosReforma({
      meses: ms, receita: serieConst(ms, 100_000), comprasCreditaveis: serieConst(ms, 40_000),
      capex: {}, cfg: { ...CFG }, pisCofinsPct: 0.0365, icmsIssPct: 0.05,
    });
    const t = 0.088 + 0.177;
    const debito = (100_000 / (1 + t)) * t;      // sem tributo antigo na base (extinto)
    const credito = (40_000 / (1 + t)) * t;
    expect(r.impostosConsumo[ms[0]]).toBeCloseTo(debito - credito, 4);
  });

  it("alíquota zero: débito 0, crédito vira SALDO CREDOR que carrega", () => {
    const ms = meses(2033);
    const r = calcularImpostosReforma({
      meses: ms, receita: serieConst(ms, 100_000), comprasCreditaveis: serieConst(ms, 40_000),
      capex: {}, cfg: { ...CFG, categoria: "zero" }, pisCofinsPct: 0.0365, icmsIssPct: 0.05,
    });
    expect(r.impostosConsumo[ms[0]]).toBe(0);
    expect(r.saldoCredor[ms[11]]).toBeGreaterThan(r.saldoCredor[ms[0]]); // acumula
  });

  it("transição 2029: mistura ICMS/ISS 90% + IBS 10% e a base nova exclui o tributo antigo", () => {
    const ms = meses(2029);
    const r = calcularImpostosReforma({
      meses: ms, receita: serieConst(ms, 100_000), comprasCreditaveis: serieConst(ms, 0),
      capex: {}, cfg: { ...CFG }, pisCofinsPct: 0.0365, icmsIssPct: 0.10,
    });
    const antigo = 100_000 * 0.10 * 0.9;
    const t = 0.088 + 0.177 * 0.1;
    const debito = ((100_000 - antigo) / (1 + t)) * t;
    expect(r.antigoRemanescente[ms[0]]).toBeCloseTo(antigo, 6);
    expect(r.impostosConsumo[ms[0]]).toBeCloseTo(antigo + debito, 4);
  });
});

describe("integração com o motor (mundo atual × mundo reforma)", () => {
  const blocos = (): BlocoModelo[] => [
    {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "lin1", nome: "Vendas", nodeRaiz: "receita",
          nodes: [
            { id: "vol", tipo: "serie", nome: "Volume", unidade: "#", params: { valorMensal: 1000 } },
            { id: "px", tipo: "preco", nome: "Preço", unidade: "R$/un", params: { valorMensal: 100 } },
            { id: "receita", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr: "vol * px" } },
          ],
        }],
      },
    },
    { id: "b2", tipo: "custos", nome: "Custos", ativo: true, config: { linhasCusto: [{ id: "cmv", nome: "CMV", modo: "pctReceita", pct: 0.4 }] } },
    { id: "b3", tipo: "impostos", nome: "Impostos", ativo: true, config: { impostos: { regime: "presumido", issPct: 0.05 } } },
  ];

  it("horizonte 2033+: reforma muda impostos sobre receita e o lucro líquido reage", () => {
    const base = { mesInicial: "2033-01", horizonteMeses: 12, blocks: blocos() };
    const atual = calcularModelo(base);
    const reforma = calcularModelo({ ...base, reforma: { ...CFG } });
    const ano = "2033";
    const impAtual = atual.agregacoes.anual["impostos-receita"]?.[ano] ?? 0;
    const impReforma = reforma.agregacoes.anual["impostos-receita"]?.[ano] ?? 0;
    expect(impAtual).toBeCloseTo(1_200_000 * (0.0365 + 0.05), 2); // PIS/COFINS + ISS
    expect(impReforma).not.toBeCloseTo(impAtual, 2);
    // conta na mão: débito−crédito do mundo novo
    const t = 0.088 + 0.177;
    const esperado = ((1_200_000) / (1 + t)) * t - ((480_000) / (1 + t)) * t;
    expect(impReforma).toBeCloseTo(esperado, 2);
    // lucro líquido muda na direção oposta ao imposto
    const llAtual = atual.agregacoes.anual["lucro-liquido"]?.[ano] ?? 0;
    const llReforma = reforma.agregacoes.anual["lucro-liquido"]?.[ano] ?? 0;
    expect(impReforma > impAtual ? llReforma < llAtual : llReforma > llAtual).toBe(true);
  });

  it("Simples: reforma NÃO muda a carga própria (permanece no DAS)", () => {
    const blocosSimples = blocos();
    blocosSimples[2].config.impostos = { regime: "simples", anexo: "III", rbt12Inicial: 3_000_000 };
    const base = { mesInicial: "2033-01", horizonteMeses: 12, blocks: blocosSimples };
    const atual = calcularModelo(base);
    const reforma = calcularModelo({ ...base, reforma: { ...CFG } });
    expect(reforma.agregacoes.anual["impostos-receita"]?.["2033"]).toBeCloseTo(atual.agregacoes.anual["impostos-receita"]?.["2033"] ?? 0, 6);
  });
});
