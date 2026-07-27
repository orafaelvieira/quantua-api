/**
 * GMD — GERENCIAMENTO MATRICIAL DE DESPESAS (F10 do PLANO_ORCAMENTO_QUANTUA.md).
 *
 * A metodologia dominante no Brasil (tradição Falconi): as despesas são geridas
 * pela VISÃO CRUZADA de PACOTES (grupos de conta que atravessam a empresa) ×
 * ENTIDADES (as unidades). A dupla checagem: o DONO DO PACOTE responde pela
 * conta em todas as unidades; o RESPONSÁVEL DA UNIDADE responde por tudo que
 * acontece nela. Nenhum real fica sem dois olhos.
 *
 * Aqui, a matemática pura da matriz: pacote casa com a linha pelo NOME
 * NORMALIZADO da conta; a coluna vem da etiqueta (unidade direta ou via CC;
 * CSC e não etiquetadas caem em "corporativo" — visíveis, nunca escondidas).
 */
import { Serie } from "./model-engine";
import { CentroCustoDim, UnidadeDim } from "./estrutura-dimensional";

export const COLUNA_CORPORATIVO = "__corp";

/** Normalização de nome de conta — a MESMA régua do resto da casa. */
export function normContaGmd(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export interface PacoteGmdDim {
  id: string;
  nome: string;
  donoUserId?: string | null;
  /** Nomes de conta (serão normalizados aqui — aceita como veio do banco). */
  contas: string[];
}

export interface LinhaGmd {
  id: string;
  nome: string;
  valores: Serie;
  unidadeId?: string | null;
  centroCustoId?: string | null;
}

export interface MatrizGmd {
  /** pacoteId → (unidadeId | __corp) → total no período. */
  celulas: Record<string, Record<string, number>>;
  totalPorPacote: Record<string, number>;
  totalPorColuna: Record<string, number>;
  /** Linhas com valor no período que NENHUM pacote cobre — cobertura visível. */
  linhasSemPacote: Array<{ id: string; nome: string; total: number }>;
  /** Fração do total coberta por pacotes (0..1). */
  cobertura: number;
}

export function calcularMatrizGmd(opts: {
  pacotes: PacoteGmdDim[];
  linhas: LinhaGmd[];
  unidades: UnidadeDim[];
  centros: CentroCustoDim[];
  /** Meses do período analisado (ex.: os 12 do exercício). */
  meses: string[];
}): MatrizGmd {
  const { pacotes, linhas, meses } = opts;
  const porCc = new Map(opts.centros.map((c) => [c.id, c]));
  const unidadesValidas = new Set(opts.unidades.filter((u) => u.ativo !== false).map((u) => u.id));

  const colunaDe = (l: LinhaGmd): string => {
    if (l.centroCustoId) {
      const cc = porCc.get(l.centroCustoId);
      // CC de unidade → a coluna da unidade; CSC (sem unidade) → corporativo.
      return cc?.unidadeId && unidadesValidas.has(cc.unidadeId) ? cc.unidadeId : COLUNA_CORPORATIVO;
    }
    return l.unidadeId && unidadesValidas.has(l.unidadeId) ? l.unidadeId : COLUNA_CORPORATIVO;
  };

  // Índice conta→pacote. Conta em DOIS pacotes é erro de cadastro: vale o
  // PRIMEIRO (ordem dada) — dupla contagem inflaria a matriz em silêncio.
  const pacoteDaConta = new Map<string, string>();
  for (const p of pacotes) {
    for (const conta of p.contas) {
      const n = normContaGmd(conta);
      if (n && !pacoteDaConta.has(n)) pacoteDaConta.set(n, p.id);
    }
  }

  const celulas: Record<string, Record<string, number>> = {};
  const totalPorPacote: Record<string, number> = {};
  const totalPorColuna: Record<string, number> = {};
  const linhasSemPacote: Array<{ id: string; nome: string; total: number }> = [];
  let totalGeral = 0;
  let totalCoberto = 0;

  for (const l of linhas) {
    const total = meses.reduce((s, m) => s + (l.valores?.[m] ?? 0), 0);
    if (total === 0) continue;
    totalGeral += total;
    const pacoteId = pacoteDaConta.get(normContaGmd(l.nome));
    const coluna = colunaDe(l);
    totalPorColuna[coluna] = (totalPorColuna[coluna] ?? 0) + total;
    if (!pacoteId) {
      linhasSemPacote.push({ id: l.id, nome: l.nome, total });
      continue;
    }
    totalCoberto += total;
    (celulas[pacoteId] ??= {})[coluna] = (celulas[pacoteId][coluna] ?? 0) + total;
    totalPorPacote[pacoteId] = (totalPorPacote[pacoteId] ?? 0) + total;
  }

  return {
    celulas,
    totalPorPacote,
    totalPorColuna,
    linhasSemPacote: linhasSemPacote.sort((a, b) => b.total - a.total),
    cobertura: totalGeral > 0 ? totalCoberto / totalGeral : 1,
  };
}
