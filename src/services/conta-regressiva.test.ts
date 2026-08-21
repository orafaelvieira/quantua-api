import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calcularContaRegressiva, type LinhaFin } from "./conta-regressiva";
import { diasBaseDe } from "./indicator-calculator";

/**
 * O FÔLEGO DE CAIXA NÃO TINHA UM ÚNICO TESTE — e ele é publicado.
 *
 * `calcularContaRegressiva` escreve `saudeFinanceira.diasDeCaixa` e uma frase que
 * entra no prompt rotulada "use como VERDADE, NÃO recalcule". Quando a régua de
 * dias divergiu entre o motor de indicadores e quem monta o prompt, a suíte
 * inteira (108 arquivos, 1.743 testes) continuou verde: nenhum teste chamava
 * esta função, e as chamadas de `generateAnalysis` nos testes não passam BP/DRE,
 * então o trecho nem executava.
 *
 * Os números são os reais da Belagro em 31/05/2026 (bancada-belagro.test.ts).
 */

const P = "31/05/2026";
const linha = (conta: string, v: number): LinhaFin => ({ conta, valores: { [P]: v } });

const BP: LinhaFin[] = [linha("Caixa e Equivalentes de Caixa", 14_803_975)];
const DRE: LinhaFin[] = [
  linha("Custo Operacional", -306_710_000),
  linha("Despesas Financeiras", -7_250_000),
];
// Desembolso da operação = 313.960.000 no acumulado de cinco meses.
const DESEMBOLSO = 313_960_000;

describe("o fôlego de caixa depende da BASE DE DIAS, e ela precisa ser a certa", () => {
  it("a janela real (150 dias) dá 7,1 dias de caixa", () => {
    const r = calcularContaRegressiva(BP, DRE, P, null, 150)!;
    expect(r.desembolsoOperacionalAno).toBe(DESEMBOLSO);
    expect(r.desembolsoDiario).toBeCloseTo(DESEMBOLSO / 150, 2);
    expect(r.diasDeCaixa!).toBeCloseTo(7.073, 3);
    expect(r.status).toBe("critico");
  });

  it("com 365 (a régua errada antiga) o mesmo caixa vira 17,2 dias — 2,4× de fôlego inventado", () => {
    const r = calcularContaRegressiva(BP, DRE, P, null, 365)!;
    expect(r.diasDeCaixa!).toBeCloseTo(17.21, 2);
    expect(r.status, "e o veredicto muda junto").toBe("atencao");
  });

  it("com 30 (a mediana do espaçamento, sem detectar o acumulado) vira 1,4 dias", () => {
    // É o outro lado do mesmo erro: sem a lista de colunas acumuladas, a régua
    // cai no espaçamento da série e trata cinco meses de despesa como um mês.
    const r = calcularContaRegressiva(BP, DRE, P, null, 30)!;
    expect(r.diasDeCaixa!).toBeCloseTo(1.41, 2);
    expect(r.status).toBe("critico");
  });

  it("a régua do produto entrega 150 SÓ quando a coluna é declarada acumulada", () => {
    // Série real da Belagro: 2024 fechado + nov/dez de 2025 + jan→mai de 2026.
    const serie = ["2024", "30/11/2025", "31/12/2025", "31/01/2026", "28/02/2026", "31/03/2026", "30/04/2026", P];
    const acumuladas = serie.filter((x) => /^\d{2}\//.test(x));
    expect(diasBaseDe(P, serie, acumuladas), "coluna acumulada de maio").toBe(150);

    // SEM A DECLARAÇÃO a régua cai no espaçamento da série — mediana de 1 mês —
    // e trata cinco meses de despesa como um. BURACO CONHECIDO E AINDA ABERTO: o
    // acervo gravado antes das árvores tem `balancetes` sem árvore e chega aqui
    // com a lista vazia. Fechar exige acertar o detector de colunas acumuladas
    // primeiro (ele descarta rótulo "MM/AAAA" e coluna de encerramento, que
    // COBREM a janela mesmo assim) — meia troca troca um erro por vários.
    expect(diasBaseDe(P, serie, []), "sem declarar, a régua não adivinha").toBe(30);
    const r = calcularContaRegressiva(BP, DRE, P, null, diasBaseDe(P, serie, []))!;
    expect(r.diasDeCaixa!, "e o fôlego publicado sai 5× menor que o real").toBeCloseTo(1.41, 2);
  });
});

describe("o que a conta regressiva publica", () => {
  it("operação que GERA caixa: diz que gerou, sem contagem regressiva", () => {
    const r = calcularContaRegressiva(BP, DRE, P, 4_000_000, 150)!;
    expect(r.mesesAteZerar).toBeNull();
    expect(r.leitura).toMatch(/a operação gerou caixa/);
    expect(r.leitura).not.toMatch(/se esgota/);
  });

  it("UM RELÓGIO SÓ: o número dos meses fica no objeto, mas NÃO entra na leitura", () => {
    // A leitura publicava "o caixa paga 7 dias" E "se esgota em cerca de 16
    // meses" — duas perguntas diferentes na mesma caixa de texto; a IA repetia
    // as duas e o relatório saía com "7 dias" no título e "17,5 meses" no corpo.
    // "Isso destrói a credibilidade do diagnóstico" (dono, 21/08/2026).
    const r = calcularContaRegressiva(BP, DRE, P, -4_611_799, 150)!;
    expect(r.mesesAteZerar!, "o número continua calculado para quem o consome").toBeCloseTo(16.05, 2);
    expect(r.leitura).not.toMatch(/se esgota|meses/);
    expect(r.leitura).toMatch(/cobre 7 dias de desembolsos/);
    expect(r.leitura, "declara o que o número É").toMatch(/caixa disponível dividido pelo gasto diário/);
    expect(r.leitura, "e diz que a operação consumiu caixa").toMatch(/consumiu caixa/);
  });

  it("o status segue SÓ o relógio publicado", () => {
    // Antes era OR dos dois relógios: um veredicto podia vir de um número que
    // ninguém via. Caixa que cobre 20 dias com queima forte: antes "critico"
    // pelos meses; agora "atencao" pelos dias, que é o que está escrito.
    const bp20 = [linha("Caixa e Equivalentes de Caixa", DESEMBOLSO / 150 * 20)];
    // queima mensal = 80 mi ÷ 5 = 16 mi; caixa ≈ 41,9 mi → 2,6 meses (< 3: "critico" na régua antiga)
    const r = calcularContaRegressiva(bp20, DRE, P, -80_000_000, 150)!;
    expect(r.diasDeCaixa!).toBeCloseTo(20, 6);
    expect(r.mesesAteZerar!).toBeLessThan(3);
    expect(r.status).toBe("atencao");
  });

  it("sem caixa no balanço não inventa número: devolve null", () => {
    expect(calcularContaRegressiva([], DRE, P, null, 150)).toBeNull();
  });

  it("sem desembolso não há dias de caixa — e a frase não afirma fôlego nem começa com 'e'", () => {
    const r = calcularContaRegressiva(BP, [], P, -1_000_000, 150);
    expect(r?.diasDeCaixa ?? null).toBeNull();
    expect(r?.leitura ?? "").not.toMatch(/cobre \d+ dia/);
    // Só sobrava a segunda parte, e ela abria o parágrafo com "e a operação…".
    expect(r?.leitura ?? "").toMatch(/^A operação consumiu caixa/);
  });

  it("depreciação NÃO conta como desembolso (não sai do caixa)", () => {
    const comDA = [...DRE, linha("Depreciação e Amortização", -13_960_000)];
    const r = calcularContaRegressiva(BP, comDA, P, null, 150)!;
    expect(r.desembolsoOperacionalAno).toBe(DESEMBOLSO - 13_960_000);
  });

  it("NADA INTERNO na frase que vai para o relatório", () => {
    const r = calcularContaRegressiva(BP, DRE, P, -4_611_799, 150)!;
    for (const palavra of ["motor", "seletor", "fold", "prompt", "YTD", "balancete", "null"]) {
      expect(r.leitura.toLowerCase(), `vocabulário interno vazou: ${palavra}`).not.toContain(palavra.toLowerCase());
    }
    // E nenhuma data de fechamento crua.
    expect(r.leitura).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });
});

describe("a conta regressiva deriva a janela da SÉRIE", () => {
  // O jeito de errar era passar um número solto. Agora quem chama entrega a
  // série e a régua do motor decide — não há mais 365 para cravar por engano.
  const SERIE = ["2024", "30/11/2025", "31/12/2025", "31/01/2026", "28/02/2026", "31/03/2026", "30/04/2026", P];
  const ACUM = SERIE.filter((x) => /^\d{2}\//.test(x));

  it("com a série declarada, entrega os mesmos 7,1 dias do cálculo direto", () => {
    const pelaSerie = calcularContaRegressiva(BP, DRE, P, null, { periodos: SERIE, periodosYTD: ACUM })!;
    const pelaMao = calcularContaRegressiva(BP, DRE, P, null, 150)!;
    expect(pelaSerie.diasDeCaixa).toBeCloseTo(pelaMao.diasDeCaixa!, 9);
    expect(pelaSerie.diasDeCaixa!).toBeCloseTo(7.073, 3);
  });

  it("a janela sai da MESMA régua que publica os prazos médios", () => {
    const pelaSerie = calcularContaRegressiva(BP, DRE, P, null, { periodos: SERIE, periodosYTD: ACUM })!;
    const dias = diasBaseDe(P, SERIE, ACUM);
    expect(pelaSerie.desembolsoDiario).toBeCloseTo(DESEMBOLSO / dias, 6);
  });
});

describe("A RÉGUA DE DIAS É UMA SÓ no repositório", () => {
  // Esta guarda existe porque o defeito passou por 108 arquivos e 1.743 testes
  // verdes: quem monta o prompt não é exercitado por teste nenhum (as chamadas de
  // `generateAnalysis` na suíte não passam BP/DRE, então o trecho nem executa).
  // Reverter a régua para `: 365` deixava a suíte inteira verde e o relatório
  // publicando dois preços para o mesmo movimento. Um assert sobre o código-fonte
  // é grosseiro, mas é o que vê o ponto exato onde o defeito viveu.
  /**
   * SÓ O CÓDIGO, sem comentário — e esta linha nasceu de um falso verde.
   *
   * Ao testar a mutação eu troquei o `365` de dentro do COMENTÁRIO em vez do
   * código: a chamada ficou com o literal e o comentário ficou com a chamada.
   * A guarda continuou verde porque a regex casava no comentário, o `tsc`
   * passou (o import só ficou sem uso) e a suíte inteira também. Guarda que lê
   * comentário não guarda nada.
   */
  const ler = (arquivo: string): string =>
    readFileSync(join(__dirname, arquivo), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*/g, "$1 ");

  it("ninguém mais assume 365 dias como base do período", () => {
    for (const arquivo of ["claude.ts", "cards-decisao.ts", "valor-na-mesa.ts", "bridge-variacao.ts", "prioridade-motor.ts", "conta-regressiva.ts"]) {
      const src = ler(arquivo);
      // Em QUALQUER posicao de argumento ou default, nao so depois de ":" — o
      // literal que passou pela guarda estava sozinho numa linha, como "365,".
      expect(src, `${arquivo} voltou a cravar 365 como base de dias`).not.toMatch(/[:(,=]\s*365\s*[,)]/);
    }
  });

  it("os consumidores da base de dias chamam diasBaseDe", () => {
    for (const arquivo of ["cards-decisao.ts", "valor-na-mesa.ts", "bridge-variacao.ts", "prioridade-motor.ts", "conta-regressiva.ts"]) {
      expect(ler(arquivo), `${arquivo} não usa a régua única`).toMatch(/diasBaseDe\(/);
    }
  });

  it("quem monta o relatório NÃO fabrica um número de dias — entrega a série", () => {
    // claude.ts é o arquivo onde a divergência nasceu, duas vezes. Ele não deve
    // calcular nem escolher a janela: passa `{ periodos, periodosYTD }` e a
    // função decide. Assim não sobra argumento numérico para cravar por engano.
    const src = ler("claude.ts");
    expect(src, "voltou a fabricar a base de dias").not.toMatch(/diasYTD\(|diasDoPeriodo\(/);
    expect(src, "a conta regressiva precisa receber a série").toMatch(/\{\s*periodos,\s*periodosYTD\s*\}/);
  });

  it("e ninguém reimplanta a expressão que ela substituiu", () => {
    for (const arquivo of ["claude.ts", "cards-decisao.ts", "valor-na-mesa.ts", "bridge-variacao.ts", "prioridade-motor.ts"]) {
      expect(ler(arquivo), `${arquivo} recopiou a régua em vez de chamá-la`).not.toMatch(/\?\s*diasYTD\(/);
    }
  });
});
