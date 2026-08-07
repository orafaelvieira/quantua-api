/**
 * REALIZADO DO BALANCETE (08/08/2026) — F2 do "realizado sem passar pelo IBR".
 *
 * Recebe LEITURAS da porta (F1) e deriva a série MENSAL por conta de RESULTADO
 * no plano DO CLIENTE — pronta para casar com o plano do orçamento (F2 rota).
 *
 * Critério contábil (o mesmo do corpus 12/12 do balancete mensal do IBR):
 * conta de RESULTADO carrega saldo ACUMULADO do exercício (YTD) — o mensal de
 * um balancete de mês é `saldoAtual assinado − saldoAnterior assinado`, ambos
 * do PRÓPRIO documento (o saldo anterior de maio É o YTD até abril). Documento
 * de período maior que um mês não vira mensal — fica de fora com aviso
 * declarado ("verde só com prova": nada de ratear acumulado inventando meses).
 *
 * Sinal pela NATUREZA DA FAMÍLIA: raiz 3 = receita (credora), raízes 4-9 =
 * gasto (devedora). Conta redutora dentro da família (devolução em 03.1.2)
 * sai NEGATIVA na própria família — o orçamento recebe o líquido correto.
 */
import type { LinhaBalancete } from "./balancete-parser";

export interface LeituraParaRealizado {
  documentId: string;
  nome: string;
  periodoInicio: string | null;
  periodoFim: string | null;
  linhas: LinhaBalancete[];
}

export interface ContaMensalRealizado {
  codigo: string;
  nome: string;
  natureza: "receita" | "gasto";
  /** "YYYY-MM" → valor do mês (assinado pela natureza da família). */
  meses: Record<string, number>;
}

export interface RealizadoDerivado {
  contas: ContaMensalRealizado[];
  /** Meses cobertos ("YYYY-MM"), ordenados. */
  meses: string[];
  /** Documentos que NÃO viraram mensal, com o motivo (acumulado etc.). */
  ignorados: Array<{ documentId: string; nome: string; motivo: string }>;
  avisos: string[];
}

const dataBr = (s: string | null): Date | null => {
  const m = (s ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
};

/** Raiz numérica da classificação ("03.1.1.01.003" → 3). */
const raizDe = (classificacao: string): number | null => {
  const m = (classificacao ?? "").trim().match(/^0*(\d+)/);
  return m ? Number(m[1][0]) : null;
};

const assinado = (valor: number, natureza: "D" | "C" | undefined, familia: "receita" | "gasto"): number => {
  // Sem natureza declarada, assume o sinal natural da família (parser já
  // devolve o valor absoluto da coluna).
  const nat = natureza ?? (familia === "receita" ? "C" : "D");
  const natural = familia === "receita" ? "C" : "D";
  return nat === natural ? valor : -valor;
};

/** Chave estável da conta: código quando existe, senão o nome normalizado. */
export const chaveConta = (codigo: string, nome: string): string =>
  (codigo || "").replace(/[^0-9a-z]/gi, "").toLowerCase() || nome.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function derivarRealizadoMensal(leituras: LeituraParaRealizado[]): RealizadoDerivado {
  const contas = new Map<string, ContaMensalRealizado>();
  const mesesSet = new Set<string>();
  const ignorados: RealizadoDerivado["ignorados"] = [];
  const avisos: string[] = [];

  for (const le of leituras) {
    const ini = dataBr(le.periodoInicio);
    const fim = dataBr(le.periodoFim);
    if (!ini || !fim) {
      ignorados.push({ documentId: le.documentId, nome: le.nome, motivo: "período do documento não identificado" });
      continue;
    }
    const mesmoMes = ini.getFullYear() === fim.getFullYear() && ini.getMonth() === fim.getMonth();
    if (!mesmoMes) {
      ignorados.push({
        documentId: le.documentId, nome: le.nome,
        motivo: `período ${le.periodoInicio} a ${le.periodoFim} cobre mais de um mês — acumulado não vira série mensal (suba os balancetes mensais do trecho)`,
      });
      continue;
    }
    const mes = `${fim.getFullYear()}-${String(fim.getMonth() + 1).padStart(2, "0")}`;
    // Só folhas: sintética/grupo somaria em dobro. Nível máximo por
    // classificação idêntica não é confiável entre sistemas — a regra segura
    // é: linha SEM filho (nenhuma outra classificação começa com a dela + separador).
    const classificacoes = le.linhas.map((l) => l.classificacao.trim());
    const temFilho = (c: string) =>
      classificacoes.some((o) => o !== c && (o.startsWith(c + ".") || (o.startsWith(c) && o.length > c.length && /[.\-]/.test(o[c.length] ?? ""))));
    for (const l of le.linhas) {
      if (l.sintetica) continue;
      const cls = l.classificacao.trim();
      if (temFilho(cls)) continue;
      const raiz = raizDe(cls);
      if (raiz === null || raiz < 3) continue; // 1/2 = patrimonial — fora da DRE
      const familia: "receita" | "gasto" = raiz === 3 ? "receita" : "gasto";
      const valorMes = assinado(l.saldoAtual, l.naturezaAtual, familia) - assinado(l.saldoAnterior, l.naturezaAnterior, familia);
      if (valorMes === 0) continue;
      const chave = chaveConta(cls, l.nome);
      const atual = contas.get(chave) ?? { codigo: cls, nome: l.nome, natureza: familia, meses: {} };
      if (atual.meses[mes] !== undefined) {
        // Dois documentos cobrindo o MESMO mês (versões paralelas): o último
        // vence, com aviso — silêncio aqui somaria em dobro.
        avisos.push(`"${l.nome}" (${cls}): mais de um balancete cobre ${mes} — prevaleceu o de "${le.nome}".`);
      }
      atual.meses[mes] = valorMes;
      contas.set(chave, atual);
      mesesSet.add(mes);
    }
  }

  return {
    contas: [...contas.values()].sort((a, b) => a.codigo.localeCompare(b.codigo, "pt-BR", { numeric: true })),
    meses: [...mesesSet].sort(),
    ignorados,
    avisos,
  };
}
