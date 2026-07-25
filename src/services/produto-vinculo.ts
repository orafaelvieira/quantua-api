/**
 * VÍNCULO DE UM REGISTRO A UM PRODUTO — a persistência do envelope.
 *
 * As regras puras vivem em produto-empresa.ts; aqui está o efeito colateral
 * (gravar produtoId/produtoVersao/nome, marcar vigente, emitir trilha), usado
 * pelos DOIS nascimentos de produto: POST /models e POST /analyses. Antes, cada
 * rota tinha sua cópia — e cópia é onde as duas verdades nascem.
 *
 * Modelo mental do usuário (24/07/2026): "Novo produto" cria PRODUTO; versão
 * sai de dentro do produto ("Nova versão…"). Por isso, quando o rótulo pedido
 * já existe, esta camada NÃO decide sozinha: devolve a colisão para quem chamou
 * perguntar ao analista (diferenciar com um complemento × declarar como nova
 * versão do produto que existe).
 */
import { prisma } from "../db/client";
import { registrarAuditoria } from "./audit-trail";
import {
  TipoProduto,
  TIPOS_PRODUTO,
  montarRotulo,
  normalizarRotulo,
  tipoCompativel,
  nomeDocumento,
} from "./produto-empresa";

/** Destino declarado pelo wizard: produto existente × produto novo. */
export interface DestinoProduto {
  produtoId?: string | null;
  produtoNovo?: { tipo?: string | null; periodo?: string | null; complemento?: string | null } | null;
}

export interface VinculoFeito {
  produtoId: string;
  rotulo: string;
  versao: number;
  /** Nome que o registro passou a ter (padrão da casa). */
  nome: string;
}

/** Rótulo pedido já é de outro produto da empresa — decisão do analista. */
export interface ColisaoProduto {
  produtoId: string;
  rotulo: string;
  pergunta: string;
}

/** Rótulo que o destino "produto novo" produziria + se está livre na empresa. */
export async function rotuloDoDestino(opts: {
  companyId: string;
  tipo: TipoProduto;
  periodo?: string | null;
  complemento?: string | null;
}): Promise<{ rotulo: string; erro?: string; existente?: { id: string; rotulo: string; versoes: number } }> {
  const { rotulo, erro } = montarRotulo(opts.tipo, { periodo: opts.periodo, complemento: opts.complemento });
  if (erro || !rotulo) return { rotulo: "", erro };
  const existente = await prisma.produtoEmpresa.findFirst({
    where: { companyId: opts.companyId, rotuloNorm: normalizarRotulo(rotulo) },
    select: { id: true, rotulo: true },
  });
  if (!existente) return { rotulo };
  const [analyses, models] = await Promise.all([
    prisma.analysis.count({ where: { produtoId: existente.id } }),
    prisma.financialModel.count({ where: { produtoId: existente.id } }),
  ]);
  return { rotulo, existente: { ...existente, versoes: analyses + models } };
}

/**
 * Vincula o registro recém-criado ao produto. Devolve `colisao` (sem vincular)
 * quando o rótulo pedido já existe — nunca funde dois produtos por conta
 * própria, nunca cria duplicata.
 */
export async function vincularAoProduto(opts: {
  companyId: string;
  empresaNome: string;
  userId: string;
  origem: "analysis" | "model";
  registroId: string;
  /** Tipo do produto quando o destino não declara (objetivo do modelo / "ibr"). */
  tipoPadrao: TipoProduto;
  /** Objetivo do modelo — valida a compatibilidade com o envelope. */
  objetivo?: string | null;
  destino: DestinoProduto;
  /** "jun/26" — IBR e Valuation. Vazio quando ainda não se sabe. */
  dataBase?: string | null;
  /** "2026" — só orçamento. */
  ano?: string | null;
}): Promise<{ vinculo?: VinculoFeito; colisao?: ColisaoProduto }> {
  let envelope = opts.destino.produtoId
    ? await prisma.produtoEmpresa.findFirst({ where: { id: String(opts.destino.produtoId), companyId: opts.companyId } })
    : null;

  if (!envelope && opts.destino.produtoNovo) {
    const pn = opts.destino.produtoNovo;
    const tipo = ((pn.tipo || opts.tipoPadrao) as TipoProduto);
    if (!TIPOS_PRODUTO.includes(tipo)) return {};
    const r = await rotuloDoDestino({ companyId: opts.companyId, tipo, periodo: pn.periodo, complemento: pn.complemento });
    if (r.erro || !r.rotulo) return {};
    if (r.existente) {
      return {
        colisao: {
          produtoId: r.existente.id,
          rotulo: r.existente.rotulo,
          pergunta: `Esta empresa já tem o produto “${r.existente.rotulo}” (${r.existente.versoes} versão(ões)). Declarar este registro como a próxima versão dele, ou dar uma diferenciação para criar um produto separado?`,
        },
      };
    }
    envelope = await prisma.produtoEmpresa.create({
      data: { companyId: opts.companyId, tipo, rotulo: r.rotulo, rotuloNorm: normalizarRotulo(r.rotulo), userId: opts.userId },
    });
    await registrarAuditoria({
      userId: opts.userId, entity: "produto_empresa", entityId: envelope.id,
      field: "criação do produto", after: { tipo, rotulo: r.rotulo, companyId: opts.companyId, naCriacaoDoRegistro: true },
      source: "produtos",
    });
  }

  if (!envelope) return {};
  const tipo = envelope.tipo as TipoProduto;
  if (!tipoCompativel(tipo, opts.origem, opts.objetivo).ok) return {};

  const [maxAnalise, maxModelo] = await Promise.all([
    prisma.analysis.aggregate({ where: { produtoId: envelope.id }, _max: { produtoVersao: true } }),
    prisma.financialModel.aggregate({ where: { produtoId: envelope.id }, _max: { produtoVersao: true } }),
  ]);
  const versao = Math.max(maxAnalise._max.produtoVersao ?? 0, maxModelo._max.produtoVersao ?? 0) + 1;

  const nome = nomeDocumento({
    tipo,
    empresa: opts.empresaNome,
    complemento: envelope.rotulo.split("—").slice(1).join("—").trim(),
    dataBase: opts.dataBase,
    ano: opts.ano,
    versao,
  });

  if (opts.origem === "analysis") {
    await prisma.analysis.update({ where: { id: opts.registroId }, data: { produtoId: envelope.id, produtoVersao: versao, nome } });
  } else {
    await prisma.financialModel.update({ where: { id: opts.registroId }, data: { produtoId: envelope.id, produtoVersao: versao, nome } });
  }

  // Envelope novo (não-IBR) sem vigente: a 1ª versão vira a vigente. No IBR a
  // vigência é derivada (maior versão concluída) — nunca ponteiro.
  if (tipo !== "ibr" && !envelope.versaoVigenteId && versao === 1) {
    await prisma.produtoEmpresa.update({ where: { id: envelope.id }, data: { versaoVigenteId: opts.registroId } });
  }

  await registrarAuditoria({
    userId: opts.userId, entity: "produto_empresa", entityId: envelope.id,
    field: "versão declarada",
    after: { origem: opts.origem, registroId: opts.registroId, nome, versao, naCriacao: true },
    source: "produtos",
  });

  return { vinculo: { produtoId: envelope.id, rotulo: envelope.rotulo, versao, nome } };
}
