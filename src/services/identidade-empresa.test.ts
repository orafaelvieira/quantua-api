import { describe, expect, it } from "vitest";
import { blocoIdentidade } from "./web-research";
import { limparRessalvaIdentidade } from "./claude";

/**
 * REGRESSÃO do caso de produção (14/08/2026): a análise entregue ao cliente
 * dizia "há incerteza sobre a identidade jurídica exata... confirme o CNPJ e a
 * razão social antes de fechar conclusões". O sistema tem o cadastro completo —
 * a IA é que pesquisava às cegas.
 */
describe("blocoIdentidade — o cadastro vira fato no prompt", () => {
  it("monta as linhas que existem, sem inventar as que faltam", () => {
    const b = blocoIdentidade({
      razaoSocial: "DUNAMYS SERVICOS LTDA",
      nomeFantasia: "Dunamys",
      cnpj: "12.345.678/0001-90",
      cnae: "8121-4/00",
      cnaeDescricao: "Limpeza em prédios e domicílios",
      municipio: "Curitiba",
      uf: "PR",
      regimeTributario: "Lucro Real",
      capitalSocial: 500000,
    });
    expect(b).toContain("Razão social: DUNAMYS SERVICOS LTDA");
    expect(b).toContain("CNPJ: 12.345.678/0001-90");
    expect(b).toContain("8121-4/00 — Limpeza em prédios e domicílios");
    expect(b).toContain("Município/UF: Curitiba/PR");
    expect(b).toContain("Capital social: R$ 500.000");
    // Campos ausentes não viram linha vazia nem "não informado".
    expect(b).not.toMatch(/Natureza jurídica/);
    expect(b).not.toMatch(/undefined|null/);
  });

  it("com cadastro mínimo, entrega ao menos a razão social", () => {
    expect(blocoIdentidade({ razaoSocial: "ACME LTDA" })).toBe("- Razão social: ACME LTDA");
  });
});

describe("limparRessalvaIdentidade — rede de segurança do resumo da web", () => {
  it("remove a frase exata que chegou ao cliente", () => {
    const resumo = [
      "**1) A empresa na web**",
      "- Vale registrar uma ressalva importante: há incerteza sobre a identidade jurídica exata, pois existem várias empresas com grafias parecidas em setores diferentes.",
      "- Site institucional ativo com catálogo de serviços.",
    ].join("\n");
    const limpo = limparRessalvaIdentidade(resumo);
    expect(limpo).not.toMatch(/incerteza/i);
    expect(limpo).toContain("Site institucional ativo");
  });

  it("pega as variações mais prováveis da mesma ressalva", () => {
    const variacoes = [
      "- É preciso confirmar o CNPJ e a razão social corretos antes de concluir.",
      "- Não foi possível confirmar a identidade da empresa pesquisada.",
      "- Atenção: possível homônimo em outro estado.",
      "- Existem empresas com nomes similares no mercado.",
    ];
    for (const v of variacoes) {
      expect(limparRessalvaIdentidade(`- Fato relevante do setor.\n${v}`)).toBe("- Fato relevante do setor.");
    }
  });

  it("não mutila conteúdo legítimo (incerteza de MERCADO pode e deve ficar)", () => {
    const resumo = "- Cenário setorial com incerteza regulatória sobre a reforma tributária em 2026.";
    // A palavra "incerteza" sozinha não é gatilho: o filtro mira identidade.
    expect(limparRessalvaIdentidade(resumo)).toBe(resumo);
  });
});
