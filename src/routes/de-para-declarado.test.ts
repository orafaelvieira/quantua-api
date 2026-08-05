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
import { aplicarDeParaDeclarado } from "./models";

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
