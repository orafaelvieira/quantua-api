/**
 * REMONTAGEM DA TABELA a partir da geometria do Cloud Vision.
 *
 * É a metade determinística do ganho: a coluna é definida pela POSIÇÃO no papel,
 * não pela interpretação do modelo. Estes testes não tocam a rede — exercitam a
 * remontagem com a mesma forma de dado que o Vision devolve.
 */
import { describe, it, expect } from "vitest";
import { agruparLinhas, costurarNumeros, matrizDasPaginas, palavrasDaResposta } from "./ocr-vision";

const P = (t: string, x: number, y: number, w = t.length * 8, h = 14) => ({ t, x, y, w, h });

/** Uma linha de balancete como o Vision entrega: código, reduzida, nome, 4 valores. */
const linhaConta = (y: number, cod: string, nome: string, v: string[]) => [
  P(cod, 60, y), P("567>3", 225, y), ...nome.split(" ").map((w, i) => P(w, 290 + i * 70, y)),
  P(v[0], 700, y), P(v[1], 830, y), P(v[2], 950, y), P(v[3], 1080, y),
];

describe("agrupamento por linha usa a altura da própria página", () => {
  it("separa linhas vizinhas com passo de 16px", () => {
    const ls = agruparLinhas([...linhaConta(100, "1", "ATIVO", ["1,00", "0,00", "0,00", "1,00"]),
                              ...linhaConta(116, "11", "CIRCULANTE", ["2,00", "0,00", "0,00", "2,00"])]);
    expect(ls).toHaveLength(2);
  });

  it("junta na MESMA linha o que está levemente desalinhado (papel torto)", () => {
    const ls = agruparLinhas([P("1101", 60, 200), P("CAIXA", 290, 203), P("1.000,00", 700, 202)]);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toHaveLength(3);
  });

  it("página vazia não quebra", () => {
    expect(agruparLinhas([])).toEqual([]);
  });
});

describe("costura de número partido pelo OCR", () => {
  it('"614." + "387,53" viram 614.387,53 (medido no documento real)', () => {
    const r = costurarNumeros([P("614.", 700, 100, 25), P("387,53", 726, 100, 41)]);
    expect(r).toHaveLength(1);
    expect(r[0].t).toBe("614.387,53");
  });

  it("NÃO junta o que já é número inteiro", () => {
    const r = costurarNumeros([P("1.000,00", 700, 100, 60), P("2.000,00", 830, 100, 60)]);
    expect(r).toHaveLength(2);
  });

  it("NÃO junta pedaços distantes (colunas diferentes)", () => {
    const r = costurarNumeros([P("614.", 700, 100, 25), P("387,53", 900, 100, 41)]);
    expect(r).toHaveLength(2);
  });
});

describe("matriz no formato que o parser tabular já consome", () => {
  const paginas = [{ palavras: [
    ...linhaConta(100, "1", "ATIVO", ["62.085.267,76", "40.481.421,93", "40.622.692,20", "61.943.997,49"]),
    ...linhaConta(116, "1101010001", "CAIXA GERAL", ["7.816,10", "4.146.103,86", "4.131.915,01", "22.004,95"]),
  ] }];

  it("devolve [codigo, nome, 4 valores] com os números convertidos", () => {
    const m = matrizDasPaginas(paginas, "07/2015 a 07/2015");
    expect(m.linhas).toHaveLength(2);
    expect(m.linhas[0]).toEqual(["1", "ATIVO", "62085267.76", "40481421.93", "40622692.2", "61943997.49"]);
    expect(m.linhas[1][1]).toBe("CAIXA GERAL");
    expect(m.periodo).toBe("07/2015 a 07/2015");
  });

  it('a coluna "Reduzida" NÃO vaza para dentro do nome', () => {
    expect(matrizDasPaginas(paginas, null).linhas[0][1]).not.toContain("567");
  });

  it("linha sem 4 valores (cabeçalho, rodapé) é descartada", () => {
    const m = matrizDasPaginas([{ palavras: [P("Conta", 60, 50), P("Nome", 290, 50), P("Saldo", 700, 50)] }], null);
    expect(m.linhas).toHaveLength(0);
  });

  it("negativo entre parênteses vira número negativo", () => {
    const m = matrizDasPaginas([{ palavras: linhaConta(100, "32", "CUSTO", ["(1.000,00)", "0,00", "0,00", "(1.000,00)"]) }], null);
    expect(m.linhas[0][2]).toBe("-1000");
  });
});

/**
 * SHAPE DA RESPOSTA — o `files:annotate` (PDF direto) devolve a árvore
 * `fullTextAnnotation`, enquanto o `images:annotate` devolve `textAnnotations`.
 * Suportar as duas é o que impede que uma variação de shape do provedor zere a
 * leitura em silêncio — e este trecho foi escrito sem poder bater contra a API,
 * então é justamente o que mais precisa de teste.
 */
describe("palavrasDaResposta lê as duas formas de resposta do Vision", () => {
  const cx = (x: number, y: number, w: number, h: number) => ({
    vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  });

  it("árvore fullTextAnnotation (o que o files:annotate devolve)", () => {
    const r = {
      fullTextAnnotation: {
        pages: [{ blocks: [{ paragraphs: [{ words: [
          { symbols: [{ text: "1" }, { text: "1" }], boundingBox: cx(60, 100, 20, 14) },
          { symbols: [{ text: "C" }, { text: "A" }, { text: "I" }, { text: "X" }, { text: "A" }], boundingBox: cx(290, 100, 50, 14) },
        ] }] }] }],
      },
    };
    const p = palavrasDaResposta(r);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ t: "11", x: 60, y: 100, w: 20, h: 14 });
    expect(p[1].t).toBe("CAIXA");
  });

  it("lista textAnnotations (o que o images:annotate devolve) tem preferência", () => {
    const r = {
      textAnnotations: [
        { description: "texto inteiro da pagina", boundingPoly: cx(0, 0, 1000, 900) },
        { description: "1101", boundingPoly: cx(60, 100, 40, 14) },
      ],
      fullTextAnnotation: { pages: [] },
    };
    const p = palavrasDaResposta(r);
    expect(p).toHaveLength(1); // o [0] é a página inteira e é descartado
    expect(p[0].t).toBe("1101");
  });

  it("vértice sem coordenada (o Vision omite zeros) não vira NaN", () => {
    const r = { fullTextAnnotation: { pages: [{ blocks: [{ paragraphs: [{ words: [
      { symbols: [{ text: "9" }], boundingBox: { vertices: [{ y: 10 }, { x: 8, y: 10 }, { x: 8, y: 24 }, { y: 24 }] } },
    ] }] }] }] } };
    const p = palavrasDaResposta(r);
    expect(p[0].x).toBe(0);
    expect(Number.isNaN(p[0].w)).toBe(false);
  });

  it("página em branco devolve lista vazia, não quebra", () => {
    expect(palavrasDaResposta({})).toEqual([]);
    expect(palavrasDaResposta({ fullTextAnnotation: { pages: [{ blocks: [] }] } })).toEqual([]);
  });
});

/**
 * OS QUATRO ACHADOS DA REVISÃO ADVERSARIAL (03/08/2026), que barrou o deploy.
 * Cada teste abaixo é o cenário concreto que o revisor reproduziu rodando código.
 */
describe("achados que barraram o deploy", () => {
  const P = (t: string, x: number, y: number, w = t.length * 8, h = 14) => ({ t, x, y, w, h });
  const conta = (y: number, cod: string, nome: string, v: string[], natureza?: string) => [
    P(cod, 60, y), P(nome, 290, y),
    P(v[0], 700, y), P(v[1], 830, y), P(v[2], 950, y), P(v[3], 1080, y),
    ...(natureza ? [P(natureza, 1080 + v[3].length * 8 + 6, y, 10)] : []),
  ];

  it("PERÍODO do cabeçalho é capturado — sem ele o balancete escaneado é REJEITADO", () => {
    const pg = { palavras: [
      P("Período:", 830, 40), P("01/07/2015", 950, 40), P("a", 1050, 40), P("31/07/2015", 1080, 40),
      ...conta(100, "1", "ATIVO", ["1.000,00", "0,00", "0,00", "1.000,00"]),
    ] };
    expect(matrizDasPaginas([pg], null).periodo).toBe("01/07/2015 a 31/07/2015");
  });

  it("período em mm/aaaa também é reconhecido", () => {
    const pg = { palavras: [P("Periodo", 800, 40), P("07/2015", 950, 40), P("a", 1030, 40), P("07/2015", 1060, 40)] };
    expect(matrizDasPaginas([pg], null).periodo).toBe("07/2015 a 07/2015");
  });

  it("SUFIXO D/C é preservado — sem ele a retificadora sem movimento troca de sinal", () => {
    // O Vision devolve "50.000,00" e "C" como palavras separadas. Descartar o "C"
    // fazia DEPRECIAÇÃO ACUMULADA virar +50.000 com as duas provas verdes.
    const m = matrizDasPaginas([{ palavras: conta(100, "1704060001", "DEPRECIACAO ACUMULADA",
      ["50.000,00", "0,00", "0,00", "50.000,00"], "C") }], null);
    expect(m.linhas[0][5]).toBe("50000 C");
  });

  it("linha com cara de conta que não rende 4 valores é CONTADA, não sumida", () => {
    // Basta o OCR ler uma vírgula como ponto para a conta inteira desaparecer.
    const m = matrizDasPaginas([{ palavras: [
      ...conta(100, "1", "ATIVO", ["1.000,00", "0,00", "0,00", "1.000,00"]),
      P("1101", 60, 116), P("CAIXA", 290, 116), P("4.146.103.86", 700, 116), P("0,00", 830, 116), P("0,00", 950, 116),
    ] }], null);
    expect(m.linhas).toHaveLength(1);
    expect(m.descartadas).toBe(1); // a conta perdida APARECE na contagem
  });

  it("documento limpo não acusa descarte", () => {
    const m = matrizDasPaginas([{ palavras: conta(100, "1", "ATIVO", ["1,00", "0,00", "0,00", "1,00"]) }], null);
    expect(m.descartadas).toBe(0);
  });
});
