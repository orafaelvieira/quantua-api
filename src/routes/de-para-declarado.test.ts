/**
 * DE-PARA DECLARADO NA COLUNA "Grupo de contas" (04/08/2026).
 *
 * O modelo do orçamento passou a trazer a coluna com lista na célula, e a volta
 * aplica o que o analista escolheu. A revisão adversarial mostrou que a primeira
 * versão desta regra reescrevia o destino INTEIRO — e junto com a conta levava o
 * `sinal`, silenciosamente.
 *
 * O estrago do cenário: linha "Créditos de PIS/COFINS" de R$ 200 mil com
 * `sinal: "reduz"` (ABATE do grupo). Trocar o grupo pela planilha a devolvia com
 * `sinal: "soma"` — o valor que subtraía passava a somar, R$ 400 mil de
 * oscilação no Lucro Bruto. A planilha NÃO tem coluna de sinal, então nem o
 * analista nem a tela tinham como suspeitar.
 */
import { describe, it, expect } from "vitest";
import { aplicarDeParaDeclarado, sinalDoTexto } from "./models";

describe("aplicarDeParaDeclarado", () => {
  it("célula em branco NÃO mexe no de-para — em branco quer dizer 'não sei'", () => {
    // A trava que impede uma planilha antiga (sem a coluna) de zerar o
    // de-para do orçamento inteiro na reimportação.
    expect(aplicarDeParaDeclarado({ conta: "Custo Operacional", sinal: "soma" }, null, "Fretes")).toBeNull();
  });

  it("grupo igual ao que já está não conta como mudança", () => {
    // Senão todo round-trip anunciaria "grupo alterado" em conta que ninguém
    // tocou, e o aviso do resumo viraria ruído que se aprende a ignorar.
    expect(aplicarDeParaDeclarado({ conta: "Custo Operacional", sinal: "soma" }, "Custo Operacional", "Fretes")).toBeNull();
  });

  it("troca a conta e PRESERVA o sinal 'reduz' — crédito continua abatendo", () => {
    const r = aplicarDeParaDeclarado({ conta: "Custo Operacional", sinal: "reduz" }, "Custos com Pessoas (MOD)", "Créditos de PIS/COFINS");
    expect(r?.destino).toEqual({ conta: "Custos com Pessoas (MOD)", sinal: "reduz" });
  });

  it("o aviso DIZ que manteve o sinal — trocar de grupo não pode virar surpresa", () => {
    const r = aplicarDeParaDeclarado({ conta: "Custo Operacional", sinal: "reduz" }, "Despesas com Vendas", "Créditos de PIS/COFINS");
    expect(r?.rotulo).toBe("Créditos de PIS/COFINS → Despesas com Vendas (mantido como (−) reduz)");
  });

  it("conta sem de-para nenhum entra como soma", () => {
    const r = aplicarDeParaDeclarado(null, "Despesas com Pessoas", "Salários");
    expect(r?.destino).toEqual({ conta: "Despesas com Pessoas", sinal: "soma" });
    expect(r?.rotulo).toBe("Salários → Despesas com Pessoas");
  });

  it("destino sem sinal declarado assume soma (dado legado)", () => {
    const r = aplicarDeParaDeclarado({ conta: "Custo Operacional" }, "Despesas com Fretes", "Fretes");
    expect(r?.destino.sinal).toBe("soma");
  });
});

/**
 * COLUNA "Sinal" DA PLANILHA (05/08/2026, Frente 3). A planilha não tinha como
 * declarar conta REDUTORA — "(-) PIS s/ Fretes", "(-) Devolução de Compras"
 * exigiam abrir o sistema e trocar conta a conta. Agora o "(−) reduz" viaja na
 * célula, com a mesma regra de tudo aqui: em branco preserva.
 */
describe("sinal declarado na planilha", () => {
  it("'(−) reduz' declarado troca o sinal mantendo o grupo", () => {
    const r = aplicarDeParaDeclarado({ conta: "Despesas com Fretes", sinal: "soma" }, null, "(-) PIS s/ Fretes", "reduz");
    expect(r?.destino).toEqual({ conta: "Despesas com Fretes", sinal: "reduz" });
    expect(r?.rotulo).toContain("agora (−) reduz");
  });

  it("grupo E sinal declarados juntos aplicam os dois", () => {
    const r = aplicarDeParaDeclarado({ conta: "Custo Operacional", sinal: "soma" }, "Despesas com Fretes", "(-) Anulação de Frete", "reduz");
    expect(r?.destino).toEqual({ conta: "Despesas com Fretes", sinal: "reduz" });
  });

  it("célula de sinal em branco preserva o reduz que já estava", () => {
    const r = aplicarDeParaDeclarado({ conta: "Custo Operacional", sinal: "reduz" }, "Despesas com Fretes", "Créditos", null);
    expect(r?.destino.sinal).toBe("reduz");
  });

  it("sinal sem grupo nenhum (nem gravado) não faz nada — não há roll-up para ter sinal", () => {
    expect(aplicarDeParaDeclarado(undefined, null, "Conta solta", "reduz")).toBeNull();
  });

  it("nada declarado e nada mudado devolve null — sem falso 'alterado' no resumo", () => {
    expect(aplicarDeParaDeclarado({ conta: "Custo Operacional", sinal: "soma" }, "Custo Operacional", "Fretes", null)).toBeNull();
  });
});

describe("sinalDoTexto", () => {
  it("lê as duas opções do dropdown e variações digitadas", () => {
    expect(sinalDoTexto("(−) reduz")).toBe("reduz");
    expect(sinalDoTexto("(-) reduz")).toBe("reduz");
    expect(sinalDoTexto("reduz")).toBe("reduz");
    expect(sinalDoTexto("(+) soma")).toBe("soma");
    expect(sinalDoTexto("soma")).toBe("soma");
  });
  it("em branco é null — 'não sei', nunca 'soma'", () => {
    expect(sinalDoTexto("")).toBeNull();
    expect(sinalDoTexto(null)).toBeNull();
    expect(sinalDoTexto("x")).toBeNull();
  });
});
