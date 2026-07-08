/**
 * BENCHMARK SETORIAL — FONTE CVM (fase 4): posiciona a empresa do IBR vs pares da
 * base CVM (~1.100 cias, trimestral) na visão LTM do período mais recente.
 * Substitui a base xlsx: SEM mapa de-para de nomes (CvmIndicator.nome = nomes do
 * MESMO motor) e com percentil por taxonomia B3 (CvmCompany.classificacao/setor).
 * Pares = SÓ o subsetor B3 real (decisão do usuário) — sem subir de nível; mínimo 3.
 */
import { prisma } from "../db/client";
import type { PeerComparisonRow } from "./peer-benchmark";

/** Indicadores comparáveis entre portes (size-independent) e sua polaridade.
 *  Nomes = EXATOS do motor (calculateIndicators). Fora da lista = não compara. */
export const CVM_COMPARAVEIS: Record<string, boolean /* maior é melhor */> = {
  "Margem Bruta": true,
  "Margem EBITDA": true,
  "Margem Líquida": true,
  "Liquidez Corrente": true,
  "Liquidez Seca": true,
  "Liquidez Imediata": true,
  "Liquidez Geral": true,
  "Prazo Médio Contas a Receber": false,
  "Prazo Médio Estoque": false,
  "Prazo Médio Fornecedores": true,
  "Ciclo Financeiro": false,
  "ROE (Retorno sobre Patrimônio Líquido)": true,
  "ROA (Retorno sobre Ativos)": true,
  "ROIC (Retorno sobre Capital Investido)": true,
  "Giro do Ativo": true,
  "Índice de Cobertura de Juros": true,
  "Dívida Líquida/EBITDA": false,
  "Endividamento Geral": false,
  "Endividamento de Curto Prazo": false,
  "Capital Terceiros s/ PL": false,
  "Imobilização do Patrimônio Líquido": false,
  "Alavancagem": false,
  "Termômetro de Kanitz": true,
  "Altman Z-Score (EM)": true,
};

export interface SegmentoCvm { classificacao: string | null; setor: string | null }
export interface ResultadoPeersCvm {
  dtFim: string | null;
  periodo: string | null; // rótulo humano: "1T26 (LTM)"
  rows: PeerComparisonRow[];
  /** Nomes de pregão das listadas usadas como pares (subsetor real, com dado no
   *  período) — transparência de metodologia no relatório (Apêndice). */
  empresas: string[];
}

const rotulo = (dtFim: string): string => {
  const tri = { "03": "1T", "06": "2T", "09": "3T", "12": "4T" }[dtFim.slice(5, 7)] ?? "?";
  return `${tri}${dtFim.slice(2, 4)} (LTM)`;
};

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.,]+/g, " ").replace(/\s+/g, " ").trim();

/** Segmento do cliente → strings EXATAS da base CVM (case/acento/pontuação variam). */
export async function resolveSegmentoCvm(seg: SegmentoCvm): Promise<SegmentoCvm> {
  const dist = await prisma.cvmCompany.findMany({
    where: { classificacao: { not: null } },
    distinct: ["classificacao", "setor"],
    select: { classificacao: true, setor: true },
  });
  const acha = (alvo: string | null, lista: Array<string | null>): string | null => {
    if (!alvo) return null;
    const n = norm(alvo);
    return lista.find((x) => x && norm(x) === n) ?? null;
  };
  return {
    classificacao: acha(seg.classificacao, dist.map((d) => d.classificacao)) ?? seg.classificacao,
    setor: acha(seg.setor, dist.map((d) => d.setor)),
  };
}

/** Período de comparação = LTM mais recente com indicadores na base. */
export async function ultimoPeriodoCvm(): Promise<string | null> {
  const r = await prisma.cvmIndicator.findFirst({
    where: { visao: "LTM", valor: { not: null } },
    orderBy: { dtFim: "desc" },
    select: { dtFim: true },
  });
  return r ? r.dtFim.toISOString().slice(0, 10) : null;
}

/**
 * Posição da empresa vs pares CVM para cada indicador comparável, com cascata
 * setor B3 → classificação → mercado (mercado incluído; o chamador decide filtrar).
 */
export async function comparePeersCvm(
  segBruto: SegmentoCvm,
  valores: Array<{ indicador: string; valor: number }>,
  minPeers = 3, // 3 concorrentes REAIS > 14 vizinhos de prateleira
): Promise<ResultadoPeersCvm> {
  const dtFimStr = await ultimoPeriodoCvm();
  if (!dtFimStr) return { dtFim: null, periodo: null, rows: [], empresas: [] };
  const dtFim = new Date(`${dtFimStr}T00:00:00Z`);
  const seg = await resolveSegmentoCvm(segBruto);

  // Quem são os pares (nome de pregão): listadas do subsetor com indicador LTM no
  // período — a mesma população dos quartis. Vai para o Apêndice do relatório.
  const empresas: string[] = seg.setor
    ? (await prisma.cvmCompany.findMany({
        where: { setor: seg.setor, indicators: { some: { visao: "LTM", dtFim, valor: { not: null } } } },
        select: { pregao: true, denom: true },
        orderBy: { denom: "asc" },
      })).map((c) => c.pregao ?? c.denom)
    : [];

  // PARES = SÓ O SUBSETOR REAL (decisão do usuário, 04/07): subir p/ classificação
  // (ex.: Bebidas → Consumo não Cíclico = Agro+Alimentos+Varejo+Higiene) compara
  // estruturas de custo incomparáveis — não é par, é prateleira. Sem 3 pares no
  // subsetor → sem percentil interno (cobertura "ausente" → referência externa/web).
  const niveis: Array<{ level: PeerComparisonRow["level"]; segment: string; filtro: object }> = [];
  if (seg.setor) niveis.push({ level: "setor", segment: seg.setor, filtro: { setor: seg.setor } });

  const rows: PeerComparisonRow[] = [];
  for (const { indicador, valor } of valores) {
    const hib = CVM_COMPARAVEIS[indicador];
    if (hib === undefined || !Number.isFinite(valor)) continue;
    for (const nivel of niveis) {
      const linhas = await prisma.cvmIndicator.findMany({
        where: { nome: indicador, visao: "LTM", dtFim, valor: { not: null }, company: nivel.filtro },
        select: { valor: true },
      });
      const vs = linhas.map((l) => l.valor as number).filter(Number.isFinite).sort((a, b) => a - b);
      if (vs.length < minPeers) continue;
      const q = (p: number) => vs[Math.min(vs.length - 1, Math.floor(p * (vs.length - 1)))];
      const abaixo = vs.filter((v) => v <= valor).length;
      rows.push({
        indicador, valor,
        p25: q(0.25), p50: q(0.5), p75: q(0.75),
        percentil: Math.round((abaixo / vs.length) * 100),
        level: nivel.level, segment: nivel.segment, count: vs.length,
        higherIsBetter: hib,
      });
      break; // achou nível com pares suficientes — não desce mais
    }
  }
  return { dtFim: dtFimStr, periodo: rotulo(dtFimStr), rows, empresas };
}
