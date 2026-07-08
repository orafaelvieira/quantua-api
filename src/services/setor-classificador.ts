/**
 * CLASSIFICADOR DE SETOR — determinístico, ZERO IA/tokens.
 *
 * Inverte o fluxo "analista escolhe → sistema valida": o sistema PROPÕE o setor com
 * evidência e o analista só confirma (decisão 08/07/2026 — setor errado envenena
 * pares, semáforo calibrado e valor na mesa).
 *
 * Como classifica: os NÚMEROS da empresa refletem o mercado real melhor que o CNAE.
 * Para cada subsetor da base CVM, conta quantos indicadores comparáveis da empresa
 * caem DENTRO da faixa p10–p90 dos pares daquele subsetor (aderência). O ranking sai
 * por taxa de aderência; só é "recomendado" quando a aderência é forte (≥ 50%) — o
 * classificador nunca finge certeza (empresa atípica → "escolha manual").
 *
 * Custo: UMA query agregada no Postgres + aritmética. Roda no refold (fora do caminho
 * da IA); o card de confirmação já encontra a proposta pronta.
 */
import { prisma } from "../db/client";
import { CVM_COMPARAVEIS, ultimoPeriodoCvm } from "./peer-benchmark-cvm";

export interface AderenciaSetor {
  /** Nome do subsetor na base CVM (ex.: "Comércio e Distribuição"). */
  setor: string;
  /** Código no picker (tabela Sector) — null se o nome não casar com a taxonomia ativa. */
  sectorCode: string | null;
  /** Indicadores da empresa DENTRO da faixa p10–p90 dos pares deste subsetor. */
  dentro: number;
  /** Indicadores testáveis (empresa tem valor E o subsetor tem ≥ MIN_PARES). */
  total: number;
  /** Nº de companhias do subsetor com dado no período. */
  nPares: number;
}

export interface PropostaSetor {
  /** Rótulo do período dos pares ("1T26 (LTM)"). */
  periodo: string | null;
  /** Melhor aderência QUANDO forte (≥ 50%); null = nenhum setor com aderência forte. */
  recomendado: AderenciaSetor | null;
  /** Top aderências (até 5), da maior para a menor. */
  ranking: AderenciaSetor[];
  geradoEm: string;
}

const MIN_PARES = 5;        // p10–p90 com menos que isso é ruído
const MIN_TESTAVEIS = 5;    // setor com poucos indicadores testáveis não entra no ranking
const ADERENCIA_FORTE = 0.5;

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.,]+/g, " ").replace(/\s+/g, " ").trim();

function ordPeriodo(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/20\d{2}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

const rotuloPeriodo = (dtFim: string): string => {
  const tri = { "03": "1T", "06": "2T", "09": "3T", "12": "4T" }[dtFim.slice(5, 7)] ?? "?";
  return `${tri}${dtFim.slice(2, 4)} (LTM)`;
};

/** Quantil pelo MESMO método do comparePeersCvm (vetor ordenado, índice truncado). */
const quantil = (vsOrdenado: number[], p: number): number =>
  vsOrdenado[Math.min(vsOrdenado.length - 1, Math.floor(p * (vsOrdenado.length - 1)))];

/**
 * Ranking de aderência da empresa a cada subsetor da base CVM.
 * Retorna null quando não há base (sem período CVM ou empresa sem indicadores).
 */
export async function classificarSetor(
  indicadores: Array<{ nome: string; valores: Record<string, unknown> }>,
  periodos: string[],
): Promise<PropostaSetor | null> {
  if (!indicadores.length || !periodos.length) return null;
  const dtFimStr = await ultimoPeriodoCvm();
  if (!dtFimStr) return null;
  const dtFim = new Date(`${dtFimStr}T00:00:00Z`);

  // Valores da empresa no período mais recente (só os indicadores comparáveis).
  const ord = [...periodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const ult = ord[ord.length - 1];
  const empresa = new Map<string, number>();
  for (const ind of indicadores) {
    if (!(ind.nome in CVM_COMPARAVEIS)) continue;
    const v = ind.valores?.[ult];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) empresa.set(ind.nome, n);
  }
  if (empresa.size === 0) return null;

  // UMA leitura da base: todos os valores LTM comparáveis do período, com o subsetor.
  const linhas = await prisma.cvmIndicator.findMany({
    where: { visao: "LTM", dtFim, valor: { not: null }, nome: { in: [...empresa.keys()] } },
    select: { nome: true, valor: true, company: { select: { setor: true, cnpj: true } } },
  });

  // Agrupa em memória: subsetor → indicador → valores; e conta companhias por subsetor.
  const grupos = new Map<string, Map<string, number[]>>();
  const cias = new Map<string, Set<string>>();
  for (const l of linhas) {
    const setor = l.company?.setor;
    if (!setor || typeof l.valor !== "number" || !Number.isFinite(l.valor)) continue;
    if (!grupos.has(setor)) { grupos.set(setor, new Map()); cias.set(setor, new Set()); }
    const porInd = grupos.get(setor)!;
    if (!porInd.has(l.nome)) porInd.set(l.nome, []);
    porInd.get(l.nome)!.push(l.valor);
    cias.get(setor)!.add(l.company!.cnpj);
  }

  // Mapa nome CVM → código do picker (tabela Sector), por nome normalizado.
  const sectors = await prisma.sector.findMany({ where: { active: true }, select: { code: true, name: true } });
  const codePorNome = new Map(sectors.map((s) => [norm(s.name), s.code]));

  const ranking: AderenciaSetor[] = [];
  for (const [setor, porInd] of grupos) {
    let dentro = 0, total = 0;
    for (const [nome, valorEmpresa] of empresa) {
      const vs = porInd.get(nome);
      if (!vs || vs.length < MIN_PARES) continue;
      const ordv = [...vs].sort((a, b) => a - b);
      total++;
      if (valorEmpresa >= quantil(ordv, 0.10) && valorEmpresa <= quantil(ordv, 0.90)) dentro++;
    }
    if (total < MIN_TESTAVEIS) continue;
    ranking.push({ setor, sectorCode: codePorNome.get(norm(setor)) ?? null, dentro, total, nPares: cias.get(setor)?.size ?? 0 });
  }
  ranking.sort((a, b) => (b.dentro / b.total) - (a.dentro / a.total) || b.total - a.total || b.nPares - a.nPares);

  const top = ranking[0];
  return {
    periodo: rotuloPeriodo(dtFimStr),
    recomendado: top && top.dentro / top.total >= ADERENCIA_FORTE ? top : null,
    ranking: ranking.slice(0, 5),
    geradoEm: new Date().toISOString(),
  };
}
