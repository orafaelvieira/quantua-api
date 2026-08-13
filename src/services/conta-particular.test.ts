import { describe, it, expect } from "vitest";
import { avaliarContaParticular, grupoImediatoDoCaminho } from "./conta-particular";

const CAMINHO_MUTUO = "Ativo Circulante > ATIVO CIRCULANTE > DIREITOS REALIZAVEIS A CURTO PRAZO > EMPRÉSTIMOS A PESSOAS LIGADAS";

describe("avaliarContaParticular", () => {
  it("nome próprio em grupo de partes ligadas é particular (caso União Agro)", () => {
    const r = avaliarContaParticular("União Agro", CAMINHO_MUTUO);
    expect(r.particular).toBe(true);
    expect(r.bloqueioDuro).toBe(false);
  });

  it("nome de EMPRESA com palavra de setor em grupo nominal é particular (Belagro Transportes, Paragominas Revendedora de Combustível)", () => {
    // O vocabulário de setor ("transporte", "combustível", "revenda") NÃO pode
    // livrar um nome de coligada/parte ligada — o grupo é inerentemente nominal.
    expect(avaliarContaParticular("Belagro Transportes", CAMINHO_MUTUO).particular).toBe(true);
    expect(avaliarContaParticular("Paragominas Revendedora de Combustivel", CAMINHO_MUTUO).particular).toBe(true);
  });

  it("folha que DESCREVE o grupo nominal não é particular (Adiantamento a coligadas)", () => {
    expect(avaliarContaParticular("Adiantamento a coligadas", "Ativo Circulante > COLIGADAS E CONTROLADAS").particular).toBe(false);
    expect(avaliarContaParticular("Outros mútuos", CAMINHO_MUTUO).particular).toBe(false);
    expect(avaliarContaParticular("Conta transitória", "Ativo > CRÉDITOS COM PESSOAS LIGADAS").particular).toBe(false);
  });

  it("razão social é particular em qualquer grupo", () => {
    expect(avaliarContaParticular("Transportes Silva LTDA", "Passivo Circulante > FORNECEDORES").particular).toBe(true);
    expect(avaliarContaParticular("Banco Sicredi S.A - C/C 000026920-6", "Ativo Circulante > BANCOS").particular).toBe(true);
    expect(avaliarContaParticular("AGRO COMERCIAL EIRELI", null).particular).toBe(true);
  });

  it("CNPJ/CPF no nome = bloqueio DURO (nunca vai ao global)", () => {
    const cnpj = avaliarContaParticular("Cliente 32.623.554/0001-31", "Clientes");
    expect(cnpj.particular).toBe(true);
    expect(cnpj.bloqueioDuro).toBe(true);
    const cpf = avaliarContaParticular("Mútuo João - 123.456.789-01", CAMINHO_MUTUO);
    expect(cpf.bloqueioDuro).toBe(true);
  });

  it("conta com vocabulário contábil genérico NÃO é particular, mesmo em grupo de contraparte", () => {
    expect(avaliarContaParticular("Clientes no exterior", "Ativo Circulante > CLIENTES").particular).toBe(false);
    expect(avaliarContaParticular("Adiantamento a fornecedores", "Ativo Circulante > DIREITOS").particular).toBe(false);
    expect(avaliarContaParticular("Duplicatas a receber", "Ativo Circulante > CLIENTES").particular).toBe(false);
  });

  it("conta genérica fora de grupo de contraparte não é particular", () => {
    expect(avaliarContaParticular("Energia elétrica", "Custos e Despesas > DESPESAS").particular).toBe(false);
    expect(avaliarContaParticular("Descontos Obtidos", "Receitas > FINANCEIRAS").particular).toBe(false);
    expect(avaliarContaParticular("Stonex", "Ativo Circulante > DISPONIBILIDADES").particular).toBe(false);
  });
});

describe("grupoImediatoDoCaminho", () => {
  it("extrai o último nível do caminho", () => {
    expect(grupoImediatoDoCaminho(CAMINHO_MUTUO)).toBe("EMPRÉSTIMOS A PESSOAS LIGADAS");
  });
  it("caminho raso ou vazio → null", () => {
    expect(grupoImediatoDoCaminho("Ativo Circulante")).toBe(null);
    expect(grupoImediatoDoCaminho(null)).toBe(null);
  });
});

/**
 * A GARANTIA DO DONO (10/08/2026): "contas adicionadas no workspace da empresa
 * devem subir para aprovação da Quantua no dicionário global, COM EXCEÇÃO de
 * contas com nomes, por exemplo mas não se limitando, MÚTUOS que aparece o
 * nome do credor/devedor".
 *
 * A régua antiga fazia o OPOSTO no caso citado: qualquer nome que CONTIVESSE
 * "mútuo"/"sócio"/"acionista" era tratado como "descreve o grupo" e ia direto
 * ao dicionário global — "Mútuos - João da Silva" incluído.
 */
describe("nome próprio não sobe ao dicionário global (garantia do dono)", () => {
  const particular = (nome: string, ctx?: string) => avaliarContaParticular(nome, ctx ?? null).particular;

  it.each([
    ["Mútuos - João da Silva", undefined],
    ["Empréstimo sócio Pedro Henrique", undefined],
    ["Mútuo Belagro Transportes", "Ativo > MÚTUOS"],
    ["G Belusso Transportes", "Ativo Circulante > EMPRÉSTIMOS A PESSOAS LIGADAS"],
    ["União Agro", "Ativo Circulante > EMPRÉSTIMOS A PESSOAS LIGADAS"],
    ["Adiantamento de estoque - WG Armazéns", "Ativo Circulante > ADIANTAMENTO A FORNECEDORES"],
    ["Transportadora Beta Ltda", undefined],
  ])("FICA na empresa: %s", (nome, ctx) => expect(particular(nome, ctx)).toBe(true));

  it.each([
    ["Mútuos", undefined],
    ["Empréstimos a sócios", undefined],
    ["Outros mútuos", "Ativo > MÚTUOS"],
    ["Duplicatas a receber", "Ativo Circulante > CLIENTES"],
    ["Duplicatas a receber - vencidas", "Ativo Circulante > CLIENTES"],
    ["Contas a pagar - curto prazo", "Passivo Circulante > FORNECEDORES"],
    ["Clientes mercado interno", "Ativo Circulante > CLIENTES"],
    ["Adiantamento de Férias", "Ativo Circulante > ADIANTAMENTOS A FUNCIONÁRIOS"],
    ["Caixa Geral", undefined],
  ])("SOBE para o global: %s", (nome, ctx) => expect(particular(nome, ctx)).toBe(false));

  it("CNPJ sem pontuação também é bloqueio duro (o contador digita dos dois jeitos)", () => {
    const r = avaliarContaParticular("12345678000199 - Fornecedor X", null);
    expect(r.particular).toBe(true);
    expect(r.bloqueioDuro).toBe(true);
  });

  it("sem contexto do documento a garantia continua valendo pelo próprio nome", () => {
    // O caminho do documento nem sempre chega ao detector — a regra não pode
    // depender disso (era fail-open).
    expect(particular("Mútuos - Maria Aparecida")).toBe(true);
  });
});

/**
 * CONTEXTO POBRE — o que a fila REALMENTE entrega (13/08/2026).
 *
 * Os testes acima alimentam o caminho IDEAL do documento ("… > EMPRÉSTIMOS A
 * PESSOAS LIGADAS") e por isso ficavam verdes enquanto a produção deixava
 * "G Belusso Transportes" esperando um clique em Aprovar: o caminho só é
 * gravado quando vem com ">", e na maioria das linhas o detector recebia só
 * "Ativo Circulante". Suíte verde com produção errada é o pior estado possível
 * — daí este bloco repetir os mesmos casos com o contexto que existe de fato.
 */
describe("avaliarContaParticular — contexto POBRE (o que a fila entrega)", () => {
  const casos: Array<[string, string | null, boolean, string]> = [
    ["G Belusso Transportes", "Ativo Circulante", true, "iniciais de razão social"],
    ["G Belusso Transportes", null, true, "sem contexto nenhum"],
    ["Adiantamento de estoque - WG Armazéns", "Ativo Circulante", true, "iniciais na cauda"],
    ["Mútuo J. Belusso", null, true, "inicial com ponto"],
    ["Clientes - Móveis Silva", "Ativo Circulante", true, "nome próprio depois do separador"],
  ];
  for (const [nome, ctx, esperado, porque] of casos) {
    it(`"${nome}" (${porque}) → particular=${esperado}`, () => {
      expect(avaliarContaParticular(nome, ctx).particular).toBe(esperado);
    });
  }
});

describe("avaliarContaParticular — identificador de terceiro é bloqueio duro", () => {
  it("número de processo judicial no nome nunca vai ao global", () => {
    const r = avaliarContaParticular("4.03.02.01 PROCESSO 000014.0316758/2020", "Outras Receitas Operacionais");
    expect(r.particular).toBe(true);
    expect(r.bloqueioDuro).toBe(true);
  });

  it("número de conta bancária também", () => {
    expect(avaliarContaParticular("Bradesco Ag.0049 C/C 0329707-1", "Ativo Circulante > BANCOS").bloqueioDuro).toBe(true);
  });

  it("o CÓDIGO do plano não é identificador de terceiro — é da própria empresa", () => {
    expect(avaliarContaParticular("1.1.1.01.0001 Caixa Geral", "Ativo Circulante").particular).toBe(false);
  });

  it("dois números curtos separados não viram um longo", () => {
    expect(avaliarContaParticular("Conta 1234 5678", "Ativo Circulante").particular).toBe(false);
  });
});

describe("avaliarContaParticular — o que NÃO pode virar particular", () => {
  const generico: Array<[string, string | null]> = [
    ["Ganho Commodities - Contratos relizados", "Outras Receitas Operacionais"],
    ["Emprestimos Pessoas Ligadas", "Passivo Circulante"],
    ["Consignados Empregados", "Passivo Circulante"],
    ["Créditos com Controladas - LP", "Ativo Não Circulante"],
    ["Partes Relacionadas - Ativo", "Ativo Não Circulante"],
    ["Lucro Líquido Atribuível aos Acionistas Controladores", "DRE"],
    ["Participação dos Não Controladores", "DRE"],
    ["Anuidades de Conselhos (CRC, CREA, OAB)", "Despesas"],
    ["Ações Classe B Preferenciais", "Patrimônio Líquido"],
    ["IR Diferido", "Ativo Não Circulante"],
    ["Fornecedores Nacionais", "Passivo Circulante > FORNECEDORES"],
    ["Duplicatas a Receber", "Ativo Circulante > CLIENTES"],
    ["3.02.01.02 ( - ) ABATIMENTOS E DEVOLUÇÕES SOBRE VENDAS", "Deduções da Receita Bruta"],
  ];
  for (const [nome, ctx] of generico) {
    it(`"${nome}" é conta de plano, não terceiro`, () => {
      expect(avaliarContaParticular(nome, ctx).particular).toBe(false);
    });
  }
});
