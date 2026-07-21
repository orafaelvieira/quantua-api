/**
 * FECHAMENTO DE PERÍODO (Workspace FP&A, W2) — regras puras.
 *
 * Princípio de desenho: NADA aqui duplica o que a Data room já faz. O Document
 * já tem versionamento (versao, substituidoPorId, status "Substituído") e
 * competência — o "documento lógico" é DERIVADO: cadeias de substituição
 * fundidas por (tipo, competência). Zero contato com o fluxo do IBR.
 *
 * O que se ARMAZENA é só o que não dá para derivar: o ATO de fechar e o de
 * reabrir (PeriodoEmpresa). Todo o resto — estado do período, retificação
 * pós-fechamento, períodos faltantes — deriva dos documentos.
 *
 * Estados do período (decisão de 20/07/2026):
 *   aberto (sem documento) → recebido (documento chegou) → fechado (ATO).
 *   "validado" (gates de integridade) entra quando o diff/gates do W2.2
 *   chegarem — não fingimos um estado que ainda não provamos.
 *
 * Determinístico, sem I/O.
 */
import { mesAdd } from "./model-engine";

export type RegimeFechamento = "contabil" | "gerencial";
export const REGIMES: RegimeFechamento[] = ["contabil", "gerencial"];

/** Documento na forma mínima que as regras precisam (espelho do Document). */
export interface DocFechamento {
  id: string;
  nome: string;
  tipo: string;
  competencia: string | null;
  versao: number;
  status: string;
  substituidoPorId: string | null;
  createdAt: Date;
  /** Moeda/unidade ("BRL (mil)") — só transporte p/ a cura na Data room. */
  moeda?: string | null;
}

/** Registro de fechamento (espelho do PeriodoEmpresa). */
export interface FechamentoRegistro {
  periodo: string;
  fechadoEm: Date | null;
  reabertoEm: Date | null;
}

export interface DocumentoLogico {
  /** tipo do documento ("Balancete", "DRE"…). */
  tipo: string;
  /** "YYYY-MM" ou null (documento sem competência declarada). */
  competencia: string | null;
  /** Versões em ordem cronológica; a exibição usa a posição (v1, v2…). */
  versoes: DocFechamento[];
  /** Última versão não substituída — a que vale. */
  vigente: DocFechamento;
}

/** Competência mensal ("2026-05"). */
const RE_MES = /^\d{4}-\d{2}$/;
/** Competência válida: mês OU exercício/ano fechado ("2025") — DF anual é
 *  documento de período tanto quanto o balancete mensal (pedido do usuário). */
const RE_COMPETENCIA = /^\d{4}(-\d{2})?$/;

/**
 * Deriva os DOCUMENTOS LÓGICOS de uma lista de documentos:
 *  1. cadeias explícitas de substituição viram um documento lógico cada;
 *  2. cadeias/avulsos com MESMA (tipo, competência YYYY-MM) se fundem — o
 *     contador que reenviou o balancete de jun/26 sem usar "Substituir" ainda
 *     assim empilha no lugar certo;
 *  3. documento sem competência e sem cadeia fica sozinho (empilhar "DRE 2023"
 *     com "DRE 2024" por terem o mesmo tipo seria mentira).
 */
export function derivarDocumentosLogicos(docs: DocFechamento[]): DocumentoLogico[] {
  const porId = new Map(docs.map((d) => [d.id, d]));
  const temAntecessor = new Set<string>();
  for (const d of docs) if (d.substituidoPorId && porId.has(d.substituidoPorId)) temAntecessor.add(d.substituidoPorId);

  // 1. Cadeias: começa em quem não é sucessor de ninguém e segue os ponteiros.
  const visitados = new Set<string>();
  const cadeias: DocFechamento[][] = [];
  for (const d of docs) {
    if (visitados.has(d.id) || temAntecessor.has(d.id)) continue;
    const cadeia: DocFechamento[] = [];
    let atual: DocFechamento | undefined = d;
    while (atual && !visitados.has(atual.id)) {
      visitados.add(atual.id);
      cadeia.push(atual);
      atual = atual.substituidoPorId ? porId.get(atual.substituidoPorId) : undefined;
    }
    cadeias.push(cadeia);
  }

  // 2. Funde por (tipo, competência válida); sem competência = grupo próprio.
  const grupos = new Map<string, DocFechamento[]>();
  let avulso = 0;
  for (const cadeia of cadeias) {
    const base = cadeia[0]!;
    const comp = base.competencia && RE_COMPETENCIA.test(base.competencia) ? base.competencia : null;
    const chave = comp ? `${base.tipo}·${comp}` : `solo·${avulso++}`;
    grupos.set(chave, [...(grupos.get(chave) ?? []), ...cadeia]);
  }

  return [...grupos.values()].map((versoes) => {
    const ordenadas = [...versoes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const vivas = ordenadas.filter((v) => v.status !== "Substituído");
    const base = ordenadas[0]!;
    return {
      tipo: base.tipo,
      competencia: base.competencia && RE_COMPETENCIA.test(base.competencia) ? base.competencia : null,
      versoes: ordenadas,
      vigente: (vivas.length ? vivas[vivas.length - 1] : ordenadas[ordenadas.length - 1])!,
    };
  });
}

export type EstadoPeriodo = "aberto" | "recebido" | "fechado";

/** O período está EFETIVAMENTE fechado? (reabertura posterior desfaz o ato). */
export function estaFechado(reg: FechamentoRegistro | null | undefined): boolean {
  if (!reg?.fechadoEm) return false;
  if (reg.reabertoEm && reg.reabertoEm.getTime() > reg.fechadoEm.getTime()) return false;
  return true;
}

/** Estado exibido do período. */
export function estadoDoPeriodo(
  reg: FechamentoRegistro | null | undefined,
  documentosDoPeriodo: DocumentoLogico[]
): EstadoPeriodo {
  if (estaFechado(reg)) return "fechado";
  return documentosDoPeriodo.length > 0 ? "recebido" : "aberto";
}

/** Fechar: só o que não está fechado. */
export function podeFechar(reg: FechamentoRegistro | null | undefined): { ok: boolean; erro?: string } {
  return estaFechado(reg) ? { ok: false, erro: "O período já está fechado." } : { ok: true };
}

/** Reabrir: só o que está fechado, e SEMPRE com motivo (fica na trilha). */
export function podeReabrir(
  reg: FechamentoRegistro | null | undefined,
  motivo: string | undefined
): { ok: boolean; erro?: string } {
  if (!estaFechado(reg)) return { ok: false, erro: "O período não está fechado." };
  if (!motivo?.trim()) return { ok: false, erro: "Reabrir um período fechado exige motivo — ele fica registrado na trilha." };
  return { ok: true };
}

/**
 * RETIFICAÇÃO PÓS-FECHAMENTO (derivada): versões criadas DEPOIS do ato de
 * fechar, num período que segue fechado. É o selo vermelho do workspace —
 * aceita-se a retificação, mas ela nunca passa despercebida.
 */
export function retificacoesAposFechamento(
  reg: FechamentoRegistro | null | undefined,
  documentosDoPeriodo: DocumentoLogico[]
): DocFechamento[] {
  if (!estaFechado(reg) || !reg?.fechadoEm) return [];
  const corte = reg.fechadoEm.getTime();
  return documentosDoPeriodo
    .flatMap((d) => d.versoes)
    .filter((v) => v.createdAt.getTime() > corte)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * PERÍODOS FALTANTES por cadência mensal: do primeiro mês com documento até o
 * MÊS ANTERIOR ao corrente (o mês corrente ainda não venceu), quais não têm
 * nenhum documento?
 *
 * Cadência mensal só se INFERE do BALANCETE — o artefato mensal por natureza.
 * BP/DRE anuais carregam competência (dez/24, dez/25) e NÃO implicam ritmo
 * mensal: cobrar jan..nov de quem entrega anual seria alarme falso (caso real
 * da Pampa Carnes). Cadência configurável por fonte chega com o W2 completo.
 *
 * Sem balancete com competência válida, sem aviso — ausência de dado nunca
 * vira afirmação (regra da casa).
 */
export function periodosFaltantes(documentos: DocumentoLogico[], hoje: Date): string[] {
  // Só competência MENSAL entra na cadência (ano fechado "2025" não implica meses).
  const comPeriodo = documentos.filter((d) => d.competencia && RE_MES.test(d.competencia) && /balancete/i.test(d.tipo));
  if (comPeriodo.length === 0) return [];

  const presentes = new Set(comPeriodo.map((d) => d.competencia!));
  const primeiro = [...presentes].sort()[0]!;
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const limite = mesAdd(mesAtual, -1);
  if (primeiro > limite) return [];

  const faltantes: string[] = [];
  for (let m = primeiro; m <= limite; m = mesAdd(m, 1)) {
    if (!presentes.has(m)) faltantes.push(m);
  }
  return faltantes;
}
