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
