import { describe, it, expect } from "vitest";
import { situacaoDoArquivo, situacaoDaBase, aindaNaoPublicado, DIAS_CHECAGEM_VALIDA } from "./cvm-sync";

/**
 * SITUAÇÃO DA BASE CVM — "verde só com prova" (04/08/2026).
 *
 * Contexto que estes testes preservam. A tela de pares mostrava só "Última
 * sincronização", que responde QUANDO NÓS RODAMOS — e não se estamos na versão
 * que a CVM publicou. As duas divergem em silêncio: ressincronizar sem novidade
 * já renova a data; a checagem semanal pode ter parado (aconteceu em 19/07/2026,
 * todos os crons desligados em produção por env var não aplicada); e falha de
 * rede era contada como "sem novidades", fazendo a tela AFIRMAR que a base
 * estava em dia sem ter conseguido perguntar.
 *
 * O que não pode regredir: NÃO SABER NUNCA VIRA VERDE. Todo caminho de dúvida
 * precisa cair em "nao-verificado" — um painel de vigilância que diz "tudo ok"
 * quando não sabe é pior do que não existir.
 */

const AGORA = new Date("2026-08-04T12:00:00Z");
const diasAtras = (d: number): Date => new Date(AGORA.getTime() - d * 86_400_000);

const emDia = {
  processadoEm: diasAtras(1),
  etag: 'W/"abc123"',
  lastModified: null,
  verificadoEm: diasAtras(1),
  versaoPublicada: 'W/"abc123"',
  verificacaoErro: null,
};

describe("situacaoDoArquivo — o verde exige prova", () => {
  it("versão publicada = versão carregada, checagem recente → em dia", () => {
    expect(situacaoDoArquivo(emDia, AGORA).situacao).toBe("em-dia");
  });

  it("versão publicada DIFERENTE da carregada → desatualizado", () => {
    const r = situacaoDoArquivo({ ...emDia, versaoPublicada: 'W/"xyz999"' }, AGORA);
    expect(r.situacao).toBe("desatualizado");
  });

  it("arquivo nunca carregado não é 'desatualizado', é 'nunca-carregado'", () => {
    // A distinção importa na tela: um pede sincronizar, o outro pede carregar
    // pela primeira vez — e "desatualizado" sugeriria que já houve base.
    expect(situacaoDoArquivo(null, AGORA).situacao).toBe("nunca-carregado");
    expect(situacaoDoArquivo({ ...emDia, processadoEm: null }, AGORA).situacao).toBe("nunca-carregado");
  });

  /* ── OS QUATRO CAMINHOS DE DÚVIDA — nenhum pode sair verde ───────────── */

  it("checagem que FALHOU não vira verde, mesmo com as versões batendo", () => {
    // Era exatamente este o defeito: erro de rede caía em `novo: false` e a tela
    // dizia "a base está na mesma versão publicada pela CVM".
    const r = situacaoDoArquivo({ ...emDia, verificacaoErro: "a CVM não respondeu à consulta de versão" }, AGORA);
    expect(r.situacao).toBe("nao-verificado");
    expect(r.motivo).toContain("falhou");
  });

  it("nunca verificado (campos recém-criados) não vira verde", () => {
    const r = situacaoDoArquivo({ ...emDia, verificadoEm: null, versaoPublicada: null }, AGORA);
    expect(r.situacao).toBe("nao-verificado");
  });

  it("checagem VELHA não vira verde — é o sinal de que a vigilância parou", () => {
    expect(situacaoDoArquivo({ ...emDia, verificadoEm: diasAtras(DIAS_CHECAGEM_VALIDA + 1) }, AGORA).situacao).toBe("nao-verificado");
    // Uma rodada semanal perdida ainda é tolerada: 8 dias cobre o cron de segunda
    // sem alarme falso. É a SEGUNDA semana seguida que precisa acusar.
    expect(situacaoDoArquivo({ ...emDia, verificadoEm: diasAtras(DIAS_CHECAGEM_VALIDA - 1) }, AGORA).situacao).toBe("em-dia");
  });

  it("sem versão comparável dos dois lados não vira verde nem vermelho por engano", () => {
    // O ZIP vindo do espelho pode gravar etag null; sem os dois lados não há o
    // que comparar, e afirmar qualquer coisa seria inventar.
    const r = situacaoDoArquivo({ ...emDia, etag: null, lastModified: null }, AGORA);
    expect(r.situacao).toBe("nao-verificado");
    expect(r.motivo).toContain("comparável");
  });
});

/**
 * O ALARME FALSO DE JANEIRO. Todo 1º de janeiro o plano ganha o ITR do ano que
 * começou e o DFP do ano que fechou — que a CVM só publica meses depois. Sem
 * esta regra a faixa acusaria "faltam 2 arquivos" de janeiro a maio, todo ano,
 * sem nada errado e sem ação possível.
 *
 * A regra é de CALENDÁRIO por decisão explícita: a alternativa mexeria na tabela
 * de estado da ingestão, onde `sincronizarHistoricoCvm` decide o que pular pela
 * existência do registro — um arquivo apenas checado passaria a ser pulado para
 * sempre, faltando um ano inteiro de dados em silêncio.
 */
describe("aindaNaoPublicado — não cobrar o que a CVM ainda não publicou", () => {
  const em = (iso: string) => new Date(iso);

  it("1º de janeiro: nem o ITR do ano nem o DFP do ano fechado são cobrados", () => {
    expect(aindaNaoPublicado("itr_2027", em("2027-01-01T12:00:00Z"))).toBe(true);
    expect(aindaNaoPublicado("dfp_2026", em("2027-01-01T12:00:00Z"))).toBe(true);
  });

  it("DFP passa a ser cobrado em maio do ano seguinte (entrega vai até 31/03)", () => {
    expect(aindaNaoPublicado("dfp_2026", em("2027-04-30T12:00:00Z"))).toBe(true);
    expect(aindaNaoPublicado("dfp_2026", em("2027-05-01T12:00:00Z"))).toBe(false);
  });

  it("ITR passa a ser cobrado em julho do próprio ano (1º trimestre vai até ~15/05)", () => {
    expect(aindaNaoPublicado("itr_2027", em("2027-06-30T12:00:00Z"))).toBe(true);
    expect(aindaNaoPublicado("itr_2027", em("2027-07-01T12:00:00Z"))).toBe(false);
  });

  it("ano passado é sempre cobrado — a regra não pode virar desculpa para arquivo velho", () => {
    expect(aindaNaoPublicado("itr_2025", em("2026-08-04T12:00:00Z"))).toBe(false);
    expect(aindaNaoPublicado("dfp_2024", em("2026-08-04T12:00:00Z"))).toBe(false);
    expect(aindaNaoPublicado("dfp_2010", em("2026-08-04T12:00:00Z"))).toBe(false);
  });

  it("nome de arquivo estranho não vira desculpa: na dúvida, COBRA", () => {
    // Fail-closed: se a regra não entende o arquivo, ele continua sendo exigido.
    expect(aindaNaoPublicado("_historico", em("2027-01-01T12:00:00Z"))).toBe(false);
    expect(aindaNaoPublicado("itr_abc", em("2027-01-01T12:00:00Z"))).toBe(false);
    expect(aindaNaoPublicado("qualquer_2030", em("2027-01-01T12:00:00Z"))).toBe(false);
  });
});

describe("situacaoDaBase — o pior caso manda", () => {
  const plano = ["itr_2026", "dfp_2025", "itr_2025"];
  const todosEmDia = new Map<string, "em-dia">([
    ["itr_2026", "em-dia"], ["dfp_2025", "em-dia"], ["itr_2025", "em-dia"],
  ]);
  const estadosDe = (dias: Record<string, number | null>) =>
    new Map(Object.entries(dias).map(([a, d]) => [a, { verificadoEm: d === null ? null : diasAtras(d) }]));
  const estados = estadosDe({ itr_2026: 1, dfp_2025: 1, itr_2025: 1 });

  it("todos em dia e nada pendente → em dia", () => {
    expect(situacaoDaBase(estados, plano, todosEmDia, []).situacao).toBe("em-dia");
  });

  it("UM arquivo desatualizado tira o verde de toda a base", () => {
    const m = new Map(todosEmDia);
    m.set("dfp_2025", "desatualizado" as never);
    const r = situacaoDaBase(estados, plano, m as never, []);
    expect(r.situacao).toBe("desatualizado");
    expect(r.desatualizados).toBe(1);
  });

  it("fila pendente derruba o verde mesmo com as versões já iguais", () => {
    // Depois de a checagem detectar e ANTES de a fila rodar, as versões podem
    // já bater e ainda haver trabalho enfileirado.
    expect(situacaoDaBase(estados, plano, todosEmDia, ["dfp_2025"]).situacao).toBe("desatualizado");
  });

  it("arquivo sem checagem válida derruba o verde (não saber ≠ estar bem)", () => {
    const m = new Map(todosEmDia);
    m.set("itr_2025", "nao-verificado" as never);
    const r = situacaoDaBase(estados, plano, m as never, []);
    expect(r.situacao).toBe("nao-verificado");
    expect(r.naoVerificados).toBe(1);
  });

  it("arquivo do plano AUSENTE do mapa conta como nunca carregado, não como em dia", () => {
    // Fail-closed: um arquivo que a tela não conhece não pode ser assumido bom.
    const r = situacaoDaBase(estados, [...plano, "dfp_2024"], todosEmDia, []);
    expect(r.situacao).toBe("nunca-carregado");
  });

  it("VIGILÂNCIA MORTA vence 'falta carregar' — a ordem é por severidade", () => {
    // O caso real que motivou tudo: crons desligados em produção por semanas.
    // Com a ordem antiga, um único arquivo faltando exibia o âmbar brando
    // "Base incompleta" e escondia 31 arquivos sem checagem nenhuma.
    const m = new Map<string, string>([
      ["itr_2026", "nao-verificado"], ["dfp_2025", "nao-verificado"], ["itr_2025", "nunca-carregado"],
    ]);
    const r = situacaoDaBase(estados, plano, m as never, []);
    expect(r.situacao).toBe("nao-verificado");
    // E o motivo não pode apagar as outras dimensões.
    expect(r.motivo).toContain("2 sem checagem válida");
    expect(r.motivo).toContain("1 nunca carregado");
  });

  it("o carimbo do selo é a checagem MAIS ANTIGA, não a mais recente", () => {
    // A mais recente esconderia um arquivo parado há meses atrás de um
    // recém-visto — e o selo passaria a mentir por otimismo.
    const mistos = estadosDe({ itr_2026: 1, dfp_2025: 5, itr_2025: 3 });
    const r = situacaoDaBase(mistos, plano, todosEmDia, []);
    expect(r.verificadoEm).toBe(diasAtras(5).toISOString());
  });

  it("UM arquivo do plano sem carimbo anula a data de cobertura", () => {
    // Sem isto a faixa dizia "toda a base verificada desde <data recente>" ao
    // lado de "N arquivos sem checagem válida" — afirmando e negando a mesma
    // coisa na mesma linha. Ausência de carimbo é ausência de prova.
    const r = situacaoDaBase(estadosDe({ itr_2026: 1, dfp_2025: 1, itr_2025: null }), plano, todosEmDia, []);
    expect(r.verificadoEm).toBeNull();
  });

  it("arquivo do plano SEM LINHA no banco também anula a cobertura", () => {
    const r = situacaoDaBase(estadosDe({ itr_2026: 1, dfp_2025: 1 }), plano, todosEmDia, []);
    expect(r.verificadoEm).toBeNull();
  });

  it("base sem nenhuma checagem devolve carimbo nulo em vez de inventar uma data", () => {
    const r = situacaoDaBase(estadosDe({ itr_2026: null, dfp_2025: null, itr_2025: null }), plano, todosEmDia, []);
    expect(r.verificadoEm).toBeNull();
  });
});
