import { describe, it, expect } from "vitest";
import { planejarImportacaoPlanoContas, AlvoDimensional, LinhaExistente } from "./plano-contas";

const UNIDADES: AlvoDimensional[] = [
  { id: "u-matriz", nome: "Matriz Sinop", codigo: "001" },
  { id: "u-sul", nome: "Filial Sorriso", codigo: "002" },
];
const CENTROS: AlvoDimensional[] = [
  { id: "cc-com", nome: "Comercial", codigo: "CC-10" },
  { id: "cc-ti", nome: "TI (CSC)", codigo: null },
];

const planejar = (contas: Parameters<typeof planejarImportacaoPlanoContas>[0]["contas"], existentes: LinhaExistente[] = []) =>
  planejarImportacaoPlanoContas({ contas, existentes, unidades: UNIDADES, centros: CENTROS });

describe("casamento da lotação", () => {
  it("casa o centro de custo por NOME (acento e caixa não importam)", () => {
    const r = planejar([{ nome: "Salários", centroCusto: "comercial" }]);
    expect(r.criar[0]!.centroCustoId).toBe("cc-com");
    expect(r.semLotacao).toEqual([]);
  });

  it("casa o centro de custo por CÓDIGO", () => {
    const r = planejar([{ nome: "Salários", centroCusto: "CC-10" }]);
    expect(r.criar[0]!.centroCustoId).toBe("cc-com");
  });

  it("casa a unidade quando não há centro de custo", () => {
    const r = planejar([{ nome: "Aluguel", unidade: "Filial Sorriso" }]);
    expect(r.criar[0]!.unidadeId).toBe("u-sul");
    expect(r.criar[0]!.centroCustoId).toBeNull();
  });

  it("CC que não existe: a conta ENTRA sem lotação e o aviso volta listado", () => {
    const r = planejar([{ nome: "Material de consumo", centroCusto: "Almoxarifado" }]);
    expect(r.criar).toHaveLength(1);
    expect(r.criar[0]!.centroCustoId).toBeNull();
    expect(r.criar[0]!.lotacao).toBe("não atribuído");
    expect(r.semLotacao[0]).toContain("Almoxarifado");
  });

  it("sem CC nem unidade na planilha não é erro — só não vira aviso", () => {
    const r = planejar([{ nome: "Conta solta" }]);
    expect(r.criar).toHaveLength(1);
    expect(r.semLotacao).toEqual([]);
  });
});

describe("dedupe (a regra que impede dobrar a despesa)", () => {
  const jaTem: LinhaExistente[] = [
    { nome: "Despesas com Viagens", centroCustoId: "cc-com" },
    { nome: "Licenças", codigo: "4.2.03.010", centroCustoId: "cc-ti" },
  ];

  it("ignora quando o CÓDIGO já existe", () => {
    const r = planejar([{ codigo: "4.2.03.010", nome: "Licenças de software", centroCusto: "TI (CSC)" }], jaTem);
    expect(r.criar).toEqual([]);
    expect(r.ignoradas[0]).toContain("4.2.03.010");
  });

  it("ignora nome repetido NA MESMA lotação mesmo com código novo", () => {
    // Foi o defeito real: com código novo a conta passava e o orçamento dobrava.
    const r = planejar([{ codigo: "9.9.9", nome: "Despesas com Viagens", centroCusto: "Comercial" }], jaTem);
    expect(r.criar).toEqual([]);
    expect(r.ignoradas).toHaveLength(1);
  });

  it("o MESMO nome em outro centro de custo é conta diferente — entra", () => {
    const r = planejar([{ nome: "Despesas com Viagens", centroCusto: "TI (CSC)" }], jaTem);
    expect(r.criar).toHaveLength(1);
    expect(r.criar[0]!.centroCustoId).toBe("cc-ti");
  });

  it("dedupe também vale DENTRO da mesma planilha (linha repetida)", () => {
    const r = planejar([
      { nome: "Vale transporte", centroCusto: "Comercial" },
      { nome: "vale  TRANSPORTE", centroCusto: "comercial" },
    ]);
    expect(r.criar).toHaveLength(1);
    expect(r.ignoradas).toHaveLength(1);
  });
});

/** CASO REAL (30/07/2026 — planilha MOVE FARMA · v1): jan/27 fechou 896.709,51
 *  no sistema contra 912.109,51 na planilha. Faltavam 15.400,00 — a conta
 *  "Combustíveis" existe TRÊS vezes no plano do cliente, com CÓDIGOS
 *  DIFERENTES (04.1.1.01.015 custo · 04.2.1.99.018 despesa · e uma terceira), e
 *  só a do meio tinha valor. O dedupe por NOME colapsou as três na primeira
 *  (zerada) e o valor da segunda foi descartado — pior: reportado como "já
 *  existia sem valores novos". No plano de contas o CÓDIGO é a identidade:
 *  códigos diferentes = contas diferentes. */
describe("mesmo nome, CÓDIGOS diferentes = contas diferentes (plano do cliente)", () => {
  it("as três Combustíveis do plano MOVE FARMA entram, e o valor não se perde", () => {
    const r = planejar([
      { codigo: "04.1.1.01.015", nome: "Combustíveis", tipo: "custo", valores: {} },
      { codigo: "04.2.1.99.018", nome: "Combustíveis", tipo: "despesa", valores: { "2027-01": 15400 } },
      { codigo: "0", nome: "Combustíveis", valores: {} },
    ]);
    expect(r.criar).toHaveLength(3);
    const comValor = r.criar.filter((c) => Object.keys(c.valores).length > 0);
    expect(comValor).toHaveLength(1);
    expect(comValor[0]!.codigo).toBe("04.2.1.99.018");
    expect(comValor[0]!.valores["2027-01"]).toBe(15400);
    // A soma da planilha tem de sobreviver à importação — é o defeito relatado.
    expect(r.criar.reduce((s, c) => s + (c.valores["2027-01"] ?? 0), 0)).toBe(15400);
    // E a tela precisa poder explicar por que há três linhas de mesmo nome.
    expect(r.mesmoNomeContasDistintas).toEqual([
      { nome: "Combustíveis", codigos: ["04.1.1.01.015", "04.2.1.99.018", "0"] },
    ]);
  });

  it("código diferente do EXISTENTE também é conta nova (não vira atualização)", () => {
    const r = planejar(
      [{ codigo: "04.2.1.99.018", nome: "Combustíveis", valores: { "2027-01": 15400 } }],
      [{ id: "l1", nome: "Combustíveis", codigo: "04.1.1.01.015", centroCustoId: null, unidadeId: null }],
    );
    expect(r.atualizar).toEqual([]);
    expect(r.criar).toHaveLength(1);
    expect(r.criar[0]!.codigo).toBe("04.2.1.99.018");
  });

  it("existente SEM código continua casando por nome (o cliente traz o código dele)", () => {
    // Não pode regredir: é o round-trip de quem cadastrou a conta na mão e
    // depois passou a usar o código do plano do cliente.
    const r = planejar(
      [{ codigo: "9.9.9", nome: "Despesas com Viagens", valores: { "2027-01": 100 } }],
      [{ id: "l9", nome: "Despesas com Viagens", centroCustoId: null, unidadeId: null }],
    );
    expect(r.criar).toEqual([]);
    expect(r.atualizar).toHaveLength(1);
    expect(r.atualizar[0]!.id).toBe("l9");
  });

  it("MESMO código repetido na planilha continua sendo uma conta só", () => {
    const r = planejar([
      { codigo: "04.2.1.99.018", nome: "Combustíveis", valores: { "2027-01": 15400 } },
      { codigo: "04.2.1.99.018", nome: "Combustíveis (frota)", valores: { "2027-01": 900 } },
    ]);
    expect(r.criar).toHaveLength(1);
    expect(r.criar[0]!.valores["2027-01"]).toBe(15400);
  });
});

/** "NADA SOME EM SILÊNCIO" (regra da casa): quando duas linhas caem MESMO na
 *  mesma conta, o valor da repetida não pode desaparecer sem aviso — foi isso
 *  que escondeu o defeito das Combustíveis por uma tela inteira. */
describe("linha repetida COM valor: aproveita o mês vazio e denuncia o conflito", () => {
  it("mês vazio na primeira é preenchido pela repetida (nada se perde)", () => {
    const r = planejar([
      { nome: "Fretes", valores: { "2027-01": 1000 } },
      { nome: "fretes", valores: { "2027-02": 2000 } },
    ]);
    expect(r.criar).toHaveLength(1);
    expect(r.criar[0]!.valores).toEqual({ "2027-01": 1000, "2027-02": 2000 });
    expect(r.duplicadasNaPlanilha[0]!.mesesAproveitados).toEqual(["2027-02"]);
  });

  it("mês com valor nas DUAS não é somado (dobraria) — volta como conflito", () => {
    const r = planejar([
      { nome: "Fretes", valores: { "2027-01": 1000 } },
      { nome: "Fretes", valores: { "2027-01": 2000 } },
    ]);
    expect(r.criar[0]!.valores["2027-01"]).toBe(1000);
    expect(r.duplicadasNaPlanilha[0]!.conflitos).toEqual([{ mes: "2027-01", ficou: 1000, ignorado: 2000 }]);
  });
});

describe("classificação e de-para", () => {
  it("tipo 'custo' vai para o bloco de custos; o resto é despesa", () => {
    const r = planejar([
      { nome: "Matéria-prima", tipo: "Custo", centroCusto: "Comercial" },
      { nome: "Aluguel", tipo: "despesa", centroCusto: "Comercial" },
      { nome: "Sem tipo", centroCusto: "Comercial" },
    ]);
    expect(r.criar.map((c) => c.ehCusto)).toEqual([true, false, false]);
  });

  it("guarda a conta canônica de destino (roll-up) e o código do cliente", () => {
    const r = planejar([{ codigo: "4.1.01.001", nome: "Salários", centroCusto: "Comercial", destino: "Despesas com Pessoas" }]);
    expect(r.criar[0]).toMatchObject({ codigo: "4.1.01.001", destino: "Despesas com Pessoas", lotacao: "Comercial" });
  });

  it("linha sem nome é descartada sem quebrar a importação", () => {
    const r = planejar([{ nome: "  " }, { nome: "Válida" }]);
    expect(r.criar.map((c) => c.nome)).toEqual(["Válida"]);
  });
});

describe("orçamento pronto (planilha com os meses preenchidos)", () => {
  it("traz a série mensal para a conta", () => {
    const r = planejar([{ nome: "Aluguel", centroCusto: "Comercial", valores: { "2026-01": 5000, "2026-02": 5200 } }]);
    expect(r.criar[0]!.valores).toEqual({ "2026-01": 5000, "2026-02": 5200 });
  });

  it("descarta mês inválido, valor não numérico e zero (zero não é premissa)", () => {
    const r = planejar([{
      nome: "Energia",
      valores: { "2026-13": 1, "jan": 2, "2026-03": Number.NaN as unknown as number, "2026-04": 0, "2026-05": 900 },
    }]);
    expect(r.criar[0]!.valores).toEqual({ "2026-05": 900 });
  });

  it("planilha só com estrutura (sem meses) cria a conta vazia", () => {
    const r = planejar([{ nome: "Conta nova", centroCusto: "Comercial" }]);
    expect(r.criar[0]!.valores).toEqual({});
  });
});

/**
 * REIMPORTAÇÃO ATUALIZA (28/07/2026) — o round-trip "baixar modelo → preencher
 * → importar" depende de: conta existente + valores = atualizar POR IDENTIDADE
 * (código, senão nome+lotação), imune a linha inserida/movida na planilha.
 */
describe("reimportação: atualizar em vez de duplicar", () => {
  const centros = [{ id: "cc1", nome: "Comercial" }];
  const existentes = [
    { id: "L1", nome: "Viagens e hospedagem", codigo: null, centroCustoId: "cc1", unidadeId: null },
    { id: "L2", nome: "Comissões sobre vendas", codigo: "4.1.9", centroCustoId: "cc1", unidadeId: null },
  ];

  it("conta existente com valores vira ATUALIZAÇÃO, não duplicata", () => {
    const r = planejarImportacaoPlanoContas({
      contas: [{ nome: "Viagens e hospedagem", centroCusto: "Comercial", valores: { "2027-01": 5000 } }],
      existentes, unidades: [], centros,
      janela: ["2027-01", "2027-02"],
    });
    expect(r.criar).toEqual([]);
    expect(r.atualizar).toEqual([{ id: "L1", nome: "Viagens e hospedagem", valores: { "2027-01": 5000 }, janela: ["2027-01", "2027-02"] }]);
  });

  it("casa pelo CÓDIGO mesmo se o nome mudou na planilha", () => {
    const r = planejarImportacaoPlanoContas({
      contas: [{ codigo: "4.1.9", nome: "Comissões s/ vendas (renomeada)", centroCusto: "Comercial", valores: { "2027-03": 900 } }],
      existentes, unidades: [], centros, janela: ["2027-03"],
    });
    expect(r.criar).toEqual([]);
    expect(r.atualizar[0]!.id).toBe("L2");
  });

  it("linha NOVA inserida no meio da planilha vira conta nova — posição não importa", () => {
    const r = planejarImportacaoPlanoContas({
      contas: [
        { nome: "Viagens e hospedagem", centroCusto: "Comercial", valores: { "2027-01": 1 } },
        { nome: "Patrocínio do rodeio", centroCusto: "Comercial", valores: { "2027-01": 2 } },
        { nome: "Comissões sobre vendas", centroCusto: "Comercial", valores: { "2027-01": 3 } },
      ],
      existentes, unidades: [], centros, janela: ["2027-01"],
    });
    expect(r.atualizar.map((a) => a.id).sort()).toEqual(["L1", "L2"]);
    expect(r.criar.map((c) => c.nome)).toEqual(["Patrocínio do rodeio"]);
  });

  it("existente SEM id (legado) continua caindo em ignoradas", () => {
    const r = planejarImportacaoPlanoContas({
      contas: [{ nome: "Viagens e hospedagem", centroCusto: "Comercial", valores: { "2027-01": 5 } }],
      existentes: [{ nome: "Viagens e hospedagem", centroCustoId: "cc1" }], unidades: [], centros,
    });
    expect(r.atualizar).toEqual([]);
    expect(r.ignoradas).toEqual(["Viagens e hospedagem"]);
  });
});
