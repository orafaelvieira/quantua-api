import { describe, expect, it } from "vitest";
import { preservarCamposDoMotor } from "../routes/ibr";
import { recomendacoesDoMotor } from "./claude";
import type { AgendaPrioridade, SinalPriorizado } from "./prioridade-motor";

/**
 * A PORTA POR ONDE A PRIORIDADE ENTRAVA SEM RÉGUA.
 *
 * `recomendacoes` era o único array da resposta da IA que entrava CRU:
 * `Array.isArray(ai.recomendacoes) ? ai.recomendacoes : []`. A irmã dela,
 * `opcoesEstrategicas`, ganhou trava em 18/08/2026 depois que uma opção sem
 * `priority` derrubou um PDF de quarenta páginas — mas com `.default("p1")`,
 * que aqui seria pior que o defeito: defaultar prioridade é inventar urgência.
 *
 * E a coluna "Prioridade" virou o ÚNICO ordenador que o credor lê, porque
 * Impacto e Esforço saíram da tabela em 20-21/08.
 */

const sinal = (id: string, nome: string, rotulo: "Alta" | "Média", preco: number): SinalPriorizado => ({
  id, nome, natureza: "saldo", valor: 1, tipoDado: "Índice",
  referencias: [{ tipo: "propria", alvo: 2, rotulo: `nível de 2024 (2,00)` }],
  referenciaQueOrdena: { tipo: "propria", alvo: 2, rotulo: `nível de 2024 (2,00)` },
  precoBRL: preco, alavanca: "Ativo Circulante", memoria: `${nome} piorou.`,
  nivelProva: rotulo === "Alta" ? "duas-fontes" : "uma-fonte", rotulo,
});

const agenda = (sinais: SinalPriorizado[], discriminou = true): AgendaPrioridade => ({
  periodo: "2025", sinais, discriminou, eixo: "preço em R$", lacunas: [],
  cobertura: { medidos: sinais.length, avaliados: 17 },
});

const A = agenda([
  sinal("traj:liquidez-corrente", "Liquidez Corrente", "Alta", 5_000_000),
  sinal("traj:endividamento-geral", "Endividamento Geral", "Média", 2_000_000),
]);

describe("a prioridade vem do motor, nunca do JSON da IA", () => {
  it("copia rótulo e base do sinal que a recomendação declarou atacar", () => {
    const r = recomendacoesDoMotor(
      [{ titulo: "Recompor o giro", sinalId: "traj:liquidez-corrente", horizonte: "0–30d", descricao: "…" }],
      A,
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.prioridade).toBe("Alta");
    expect(r[0]!.base).toBe("nível de 2024 (2,00)");
    expect(r[0]!.sinalId).toBe("traj:liquidez-corrente");
  });

  it("IGNORA a prioridade que a IA tentar escrever por conta própria", () => {
    const r = recomendacoesDoMotor(
      [{ titulo: "X", sinalId: "traj:endividamento-geral", prioridade: "Alta", horizonte: "" }],
      A,
    );
    expect(r[0]!.prioridade, "o rótulo tem de vir do sinal, não do JSON").toBe("Média");
  });

  it("sinalId FORA da agenda não vira 'Média' nem 'Baixa': vira ausência declarada", () => {
    const r = recomendacoesDoMotor([{ titulo: "Inventada", sinalId: "traj:nao-existe", horizonte: "" }], A);
    expect(r).toHaveLength(1);
    expect(r[0]!.prioridade).toBeNull();
    // Ausência se representa com AUSÊNCIA: uma string sentinela em `base` era
    // publicada pela tela como "Prioridade medida contra sem prioridade medida."
    expect(r[0]!.base).toBeUndefined();
    expect(r[0]!.sinalId).toBeUndefined();
  });

  it("o TEXTO não se perde quando o vínculo falha — só a ordenação", () => {
    const r = recomendacoesDoMotor(
      [{ titulo: "Sucessão familiar", descricao: "Tema real, sem número que o meça." }],
      A,
    );
    expect(r[0]!.titulo).toBe("Sucessão familiar");
    expect(r[0]!.descricao).toBe("Tema real, sem número que o meça.");
    expect(r[0]!.prioridade).toBeNull();
  });

  it("ORDENA pela agenda, não pela ordem em que a IA devolveu", () => {
    const r = recomendacoesDoMotor(
      [
        { titulo: "Segunda", sinalId: "traj:endividamento-geral", horizonte: "" },
        { titulo: "Sem vínculo", horizonte: "" },
        { titulo: "Primeira", sinalId: "traj:liquidez-corrente", horizonte: "" },
      ],
      A,
    );
    expect(r.map((x) => x.titulo)).toEqual(["Primeira", "Segunda", "Sem vínculo"]);
  });

  it("UM SINAL, UMA AÇÃO: a segunda no mesmo sinalId perde o vínculo", () => {
    // Duas recomendações no mesmo sinal empatariam a ordem e o desempate viraria
    // arbitrário — a ordem do plano voltaria a mudar a cada regeração.
    const r = recomendacoesDoMotor(
      [
        { titulo: "A", sinalId: "traj:liquidez-corrente", horizonte: "" },
        { titulo: "B", sinalId: "traj:liquidez-corrente", horizonte: "" },
      ],
      A,
    );
    expect(r[0]!.prioridade).toBe("Alta");
    expect(r[1]!.prioridade).toBeNull();
    expect(r[1]!.base).toBeUndefined();
  });

  it("agenda que NÃO discriminou não publica rótulo em linha nenhuma", () => {
    const semSeparacao = agenda(A.sinais, false);
    const r = recomendacoesDoMotor(
      [{ titulo: "X", sinalId: "traj:liquidez-corrente", horizonte: "" }],
      semSeparacao,
    );
    expect(r[0]!.prioridade, "ordem eleita pelo alfabeto não vira Alta").toBeNull();
    // A base continua: o leitor vê contra o que foi comparado, mesmo sem rótulo.
    expect(r[0]!.base).toBe("nível de 2024 (2,00)");
  });

  it("SEM AGENDA (base insuficiente) nada recebe prioridade", () => {
    const r = recomendacoesDoMotor([{ titulo: "X", sinalId: "traj:liquidez-corrente" }], null);
    expect(r[0]!.prioridade).toBeNull();
    expect(r[0]!.base).toBeUndefined();
  });

  it("NENHUMA recomendação carrega texto sentinela em `base`", () => {
    const r = recomendacoesDoMotor(
      [
        { titulo: "com vínculo", sinalId: "traj:liquidez-corrente" },
        { titulo: "sem vínculo" },
        { titulo: "vínculo inválido", sinalId: "traj:fantasma" },
      ],
      A,
    );
    for (const x of r) {
      if (x.base !== undefined) expect(x.base, "base não pode ser frase de ausência").not.toMatch(/sem prioridade|não medid|indisponív/i);
    }
  });

  it("lixo na entrada não derruba nem inventa: item sem título não entra", () => {
    expect(recomendacoesDoMotor([{ titulo: "   " }, null, 42, { descricao: "só isso" }], A)).toEqual([]);
    expect(recomendacoesDoMotor("não é array", A)).toEqual([]);
    expect(recomendacoesDoMotor(undefined, A)).toEqual([]);
  });

  it("campos de texto com tipo errado não vazam para o relatório", () => {
    // A IA já mandou number onde o tipo dizia string e derrubou o PDF inteiro
    // ((t ?? "").trim is not a function). Aqui o campo errado vira vazio.
    const r = recomendacoesDoMotor(
      [{ titulo: "X", sinalId: "traj:liquidez-corrente", horizonte: 30, descricao: 12_700_000 }],
      A,
    );
    expect(r[0]!.horizonte).toBe("");
    expect(r[0]!.descricao).toBe("");
  });
});

describe("a edição do analista não alcança a prioridade do motor", () => {
  const gravadas = [
    { titulo: "Recompor o giro", prioridade: "Alta", base: "nível de 04/2026 (4,65%)", sinalId: "traj:liquidez-imediata", valorEstimado: null },
    { titulo: "Alongar o circulante", prioridade: "Média", base: "nível de 04/2026 (95,3%)", sinalId: "traj:endividamento-de-curto-prazo" },
  ];

  it("o valor estimado é gravado e os campos do motor sobrevivem", () => {
    const r = preservarCamposDoMotor(
      [{ titulo: "Recompor o giro", valorEstimado: 1_500_000 }, { titulo: "Alongar o circulante" }],
      gravadas,
    );
    expect(r[0]!.valorEstimado).toBe(1_500_000);
    expect(r[0]!.prioridade).toBe("Alta");
    expect(r[0]!.base).toBe("nível de 04/2026 (4,65%)");
    expect(r[1]!.sinalId).toBe("traj:endividamento-de-curto-prazo");
  });

  it("prioridade e base FORJADAS pelo cliente são descartadas", () => {
    // `.passthrough()` no schema deixaria passar qualquer coisa; a autoridade do
    // motor tem de valer na escrita, senão o relatório publica rótulo inventado
    // sob um cabeçalho que promete régua.
    const r = preservarCamposDoMotor(
      [{ titulo: "Recompor o giro", prioridade: "Alta", base: "porque sim", sinalId: "covenant:inventado" }],
      gravadas,
    );
    expect(r[0]!.base).toBe("nível de 04/2026 (4,65%)");
    expect(r[0]!.sinalId).toBe("traj:liquidez-imediata");
  });

  it("título que não existe no gravado NÃO herda os campos de outra linha", () => {
    const r = preservarCamposDoMotor(
      [{ titulo: "Ação nova do analista", prioridade: "Alta", base: "inventada" }],
      gravadas,
    );
    expect(r[0]!.prioridade).toBeUndefined();
    expect(r[0]!.base).toBeUndefined();
  });

  it("TÍTULOS REPETIDOS não trocam a base de um sinal pela do outro", () => {
    // O plano deduplica por sinalId, não por texto: duas ações podem se chamar
    // "Reduzir estoque" — uma do prazo de estoque, outra do covenant. Casando por
    // título, salvar o valor estimado copiava a base da PRIMEIRA para as duas e o
    // relatório publicava a referência de um sinal ao lado da ação de outro.
    const doisIguais = [
      { titulo: "Reduzir estoque", prioridade: "Alta", base: "mediana de 6 pares (60 dias)", sinalId: "pares:prazo-medio-estoque" },
      { titulo: "Reduzir estoque", prioridade: "Média", base: "limite contratual <= 3,00", sinalId: "covenant:alavancagem" },
    ];
    const r = preservarCamposDoMotor(
      [{ titulo: "Reduzir estoque", valorEstimado: 10_000 }, { titulo: "Reduzir estoque" }],
      doisIguais,
    );
    expect(r[0]!.base).toBe("mediana de 6 pares (60 dias)");
    expect(r[0]!.sinalId).toBe("pares:prazo-medio-estoque");
    expect(r[1]!.base, "a segunda linha herdou a base da primeira").toBe("limite contratual <= 3,00");
    expect(r[1]!.prioridade).toBe("Média");
    expect(r[0]!.valorEstimado).toBe(10_000);
  });

  it("tamanhos DIFERENTES: só título único dos dois lados herda", () => {
    const r = preservarCamposDoMotor(
      [{ titulo: "Recompor o giro" }, { titulo: "Novidade" }, { titulo: "Alongar o circulante" }],
      gravadas,
    );
    expect(r[0]!.prioridade).toBe("Alta");
    expect(r[1]!.prioridade, "título que não existe no gravado").toBeUndefined();
    expect(r[2]!.prioridade).toBe("Média");
  });

  it("tamanhos diferentes COM título repetido: ninguém herda (rótulo errado é pior que nenhum)", () => {
    const dup = [
      { titulo: "X", prioridade: "Alta", base: "a", sinalId: "s1" },
      { titulo: "X", prioridade: "Média", base: "b", sinalId: "s2" },
    ];
    const r = preservarCamposDoMotor([{ titulo: "X" }], dup);
    expect(r[0]!.prioridade).toBeUndefined();
    expect(r[0]!.base).toBeUndefined();
  });

  it("sem nada gravado antes, nenhum campo do motor entra", () => {
    const r = preservarCamposDoMotor([{ titulo: "X", prioridade: "Alta", base: "inventada" }], []);
    expect(r[0]!.prioridade).toBeUndefined();
    expect(r[0]!.base).toBeUndefined();
    expect(r[0]!.titulo).toBe("X");
  });
});
