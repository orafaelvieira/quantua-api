/**
 * ZERO À ESQUERDA NO NÍVEL 1 — a duplicação simétrica que passou verde.
 *
 * Caso Belagro 12/2025 (17/08/2026, relato do dono "erro ao rodar os documentos
 * da Belagro"). O "Balancete - Belagro - 12.2025_Auditado.csv" imprime a raiz
 * SEM zero ("1 ATIVO") e os filhos COM ("01.1 ATIVO CIRCULANTE"); os outros três
 * balancetes da MESMA empresa imprimem "01". A árvore casava pai e filho por
 * prefixo de TEXTO, e "01.1".startsWith("1") é falso: a raiz virava folha solta
 * ao lado dos próprios filhos e o Ativo entrava DUAS vezes.
 *
 * O que faz este caso valer um arquivo de teste próprio não é o defeito — é o
 * fato de que ele passou por TODAS as provas:
 *
 *   Ativo montado ....... R$ 242.398.476,82   (documento: R$ 121.199.238,41)
 *   Passivo montado ..... R$ 218.663.749,12   (documento: R$ 113.566.146,02)
 *   DRE montada ......... R$  15.266.184,78   (documento: R$   7.633.092,39)
 *   partida dobrada ..... ✓ passou
 *   fechamento .......... ✓ passou
 *   linha a linha ....... ✓ passou
 *
 * Provas internas conferem o documento contra ele mesmo — e duplicação SIMÉTRICA
 * é invisível para todas elas. Daí as duas travas aqui: a árvore tem de nascer
 * certa (1) e, se algum dia nascer errada de outro jeito, o RESUMO declarado no
 * rodapé tem de reprovar em voz alta (2).
 */
import { describe, it, expect } from "vitest";
import { parseBalanceteMatriz } from "./balancete-tabular";
import { converterBalancete, codigoEhAncestral, prepararArvore } from "./balancete-conversao";

const CAB = ["Classificação", "Nome da conta contábil", "Saldo anterior", "Débito", "Crédito", "Saldo atual"];
type Linha = [string, string, string, string, string, string];
const ler = (linhas: Linha[], rodape: string[][] = []) =>
  parseBalanceteMatriz([["01/12/2025 a 31/12/2025"], CAB, ...linhas, ...rodape] as never);
const converter = (linhas: Linha[], rodape: string[][] = []) =>
  converterBalancete({ ...ler(linhas, rodape), avisos: [] });

/**
 * Mesma anatomia do documento real, encurtada: raiz nível 1 sem zero, filhos com
 * zero. Ativo 1.200 · Passivo 900 · lucro 300 (receita 1.000 − custo 700).
 */
const MISTO: Linha[] = [
  ["1", "ATIVO", "1000.00", "500.00", "300.00", "1200.00"],
  ["01.1", "ATIVO CIRCULANTE", "600.00", "500.00", "300.00", "800.00"],
  ["01.2", "ATIVO NÃO CIRCULANTE", "400.00", "0.00", "0.00", "400.00"],
  ["2", "PASSIVO", "1000.00", "200.00", "100.00", "900.00"],
  ["02.1", "PASSIVO CIRCULANTE", "1000.00", "200.00", "100.00", "900.00"],
  ["3", "RECEITAS", "0.00", "0.00", "1000.00", "1000.00"],
  ["03.1", "RECEITAS OPERACIONAIS", "0.00", "0.00", "1000.00", "1000.00"],
  ["4", "CUSTOS E DESPESAS", "0.00", "700.00", "0.00", "700.00"],
  ["04.1", "CUSTOS", "0.00", "700.00", "0.00", "700.00"],
];
/** O MESMO balancete com o nível 1 zerado à esquerda — o jeito que já funcionava. */
const PADRONIZADO: Linha[] = MISTO.map(
  (l) => [/^\d$/.test(l[0]) ? `0${l[0]}` : l[0], ...l.slice(1)] as Linha,
);

describe("nível 1 sem zero à esquerda nesta o mesmo balancete de sempre", () => {
  it("a raiz adota os filhos: 4 grupos, não 9 raízes soltas", () => {
    const { grupos } = prepararArvore(ler(MISTO));
    expect(grupos.map((g) => g.no.linha.classificacao)).toEqual(["1", "2", "3", "4"]);
  });

  it("Ativo, Passivo e DRE saem iguais ao documento — não dobrados", () => {
    const c = converter(MISTO);
    expect(c.provas.fechamento.ativo).toBe(1200);
    expect(c.provas.fechamento.passivo).toBe(900);
    expect(c.resultadoAcumulado).toBe(300);
    expect(c.provas.fechamento.ok).toBe(true);
  });

  it("é indistinguível do balancete com zero — mesma leitura, mesmos números", () => {
    const misto = converter(MISTO), padrao = converter(PADRONIZADO);
    expect(misto.provas.fechamento).toEqual(padrao.provas.fechamento);
    expect(misto.resultadoAcumulado).toBe(padrao.resultadoAcumulado);
    expect(JSON.stringify(misto.arvoreDRE)).toBe(JSON.stringify(padrao.arvoreDRE));
  });

  it("a régua histórica de prefixo de texto continua valendo", () => {
    expect(codigoEhAncestral("1.1", "1.1.2")).toBe(true);      // hierárquico
    expect(codigoEhAncestral("1.1.1", "1.1.11")).toBe(true);   // Protheus
    expect(codigoEhAncestral("11211", "11211001")).toBe(true); // corrida
    expect(codigoEhAncestral("1", "01.1")).toBe(true);         // o caso Belagro
    expect(codigoEhAncestral("01", "1.1")).toBe(true);         // e o inverso
    expect(codigoEhAncestral("1.1", "1.2")).toBe(false);       // irmãos
    expect(codigoEhAncestral("10", "1.0.1")).toBe(false);      // "10" não é "1"
    expect(codigoEhAncestral("1.1", "1.1")).toBe(false);       // ele mesmo
  });
});

/**
 * P5 — o rodapé é a ÚNICA prova que enxerga duplicação simétrica, porque o
 * número não vem do motor: vem escrito pelo contador.
 */
describe("P5: o que o motor monta × o RESUMO que o documento declara", () => {
  /** Rodapé no formato do sistema real, com as palavras COLADAS e uma por linha. */
  const RODAPE = (ativo: string, passivo: string, receitas: string, custos: string, lucro: string) => [
    ["Resumo"],
    ["ATIVO", ativo, "PASSIVO", passivo],
    ["CUSTOS EDESPESAS", custos, "RECEITAS", receitas],
    ["Totaldedébitos", "1.400,00"],
    ["Totaldecréditos", "1.400,00"],
    ["Diferençaentredébitoecrédito", "0"],
    ["Lucrodoperíodo", lucro],
  ];

  it("lê os rótulos colados e os totais em linhas separadas", () => {
    const b = ler(MISTO, RODAPE("1.200,00", "900,00", "1.000,00", "700,00", "300,00"));
    expect(b.resumo).toEqual({ ativo: 1200, passivo: 900, receitas: 1000, custosDespesas: 700, resultado: 300 });
    expect(b.totais).toEqual({ debito: 1400, credito: 1400 });
  });

  it("os cinco itens passam quando a montagem reproduz o documento", () => {
    const c = converter(MISTO, RODAPE("1.200,00", "900,00", "1.000,00", "700,00", "300,00"));
    expect(c.provas.resumoDeclarado?.ok).toBe(true);
    expect(c.provas.resumoDeclarado?.itens.map((x) => x.o)).toEqual(
      ["Ativo", "Passivo", "Receitas", "Custos e despesas", "Resultado do período"],
    );
  });

  it("duplicação SIMÉTRICA reprova aqui — é a prova que faltava", () => {
    // Exatamente o que o defeito produzia: tudo em dobro, e por isso nenhuma
    // prova interna reclamava. O declarado é o do documento (não dobrado).
    const c = converter(MISTO, RODAPE("2.400,00", "1.800,00", "2.000,00", "1.400,00", "600,00"));
    expect(c.provas.fechamento.ok).toBe(true);         // a prova interna passa…
    expect(c.provas.partidaDobrada.ok).toBe(true);     // …esta também…
    expect(c.provas.resumoDeclarado?.ok).toBe(false);  // …e o rodapé reprova.
    expect(c.provas.resumoDeclarado?.itens.filter((x) => !x.ok).map((x) => x.o)).toEqual(
      ["Ativo", "Passivo", "Receitas", "Custos e despesas", "Resultado do período"],
    );
    expect(c.avisos.join(" ")).toMatch(/RESUMO do próprio documento declara/);
  });

  it("PL em raiz PRÓPRIA: o rodapé pode declarar o passivo com ou sem ele", () => {
    // Anatomia do caso Clorofila — "PATRIMÔNIO LÍQUIDO" é raiz de nível 1, não
    // filho de PASSIVO. Aí o passivo montado (700) não inclui o PL (200), e não
    // se sabe qual dos dois o sistema escreveu no rodapé: as duas leituras valem.
    const plRaiz: Linha[] = [
      ["1", "ATIVO", "1000.00", "500.00", "300.00", "1200.00"],
      ["2", "PASSIVO", "900.00", "200.00", "0.00", "700.00"],
      ["3", "PATRIMÔNIO LÍQUIDO", "0.00", "0.00", "200.00", "200.00"],
      ["4", "RECEITAS", "0.00", "0.00", "1000.00", "1000.00"],
      ["5", "CUSTOS E DESPESAS", "0.00", "700.00", "0.00", "700.00"],
    ];
    expect(converter(plRaiz).provas.fechamento.ok).toBe(true);
    expect(converter(plRaiz, [["Resumo"], ["PASSIVO", "700,00"]]).provas.resumoDeclarado?.ok).toBe(true);
    expect(converter(plRaiz, [["Resumo"], ["PASSIVO", "900,00"]]).provas.resumoDeclarado?.ok).toBe(true);
    // O dobro reprova nas duas convenções — é para isto que a prova existe.
    expect(converter(plRaiz, [["Resumo"], ["PASSIVO", "1.400,00"]]).provas.resumoDeclarado?.ok).toBe(false);
  });

  it("PL como filho de PASSIVO: o passivo montado já vem com ele somado", () => {
    // Anatomia dos quatro balancetes da Belagro. O rodapé declara "PASSIVO
    // 113.566.146,02", que é o total da raiz 02 — PL incluído.
    const plFilho: Linha[] = [
      ["1", "ATIVO", "1000.00", "500.00", "300.00", "1200.00"],
      ["2", "PASSIVO", "1000.00", "200.00", "100.00", "900.00"],
      ["02.1", "PASSIVO CIRCULANTE", "1000.00", "200.00", "0.00", "700.00"],
      ["02.3", "PATRIMÔNIO LÍQUIDO", "0.00", "0.00", "200.00", "200.00"],
      ["3", "RECEITAS", "0.00", "0.00", "1000.00", "1000.00"],
      ["4", "CUSTOS E DESPESAS", "0.00", "700.00", "0.00", "700.00"],
    ];
    expect(converter(plFilho).provas.fechamento.ok).toBe(true);
    expect(converter(plFilho, [["Resumo"], ["PASSIVO", "900,00"]]).provas.resumoDeclarado?.ok).toBe(true);
    expect(converter(plFilho, [["Resumo"], ["PASSIVO", "1.800,00"]]).provas.resumoDeclarado?.ok).toBe(false);
  });

  it("documento sem resumo não ganha prova nenhuma — ausência não é aprovação", () => {
    expect(converter(MISTO).provas.resumoDeclarado).toBeUndefined();
  });
});
