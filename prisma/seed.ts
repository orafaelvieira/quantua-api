import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface SeedEntry {
  nomeOriginal: string;
  contaDestino: string;
  grupoConta: string;
}

const BP_SEED: SeedEntry[] = [
  // === ATIVO TOTAL ===
  { nomeOriginal: "Total do Ativo", contaDestino: "Ativo Total", grupoConta: "Ativo Total" },
  { nomeOriginal: "Total Geral do Ativo", contaDestino: "Ativo Total", grupoConta: "Ativo Total" },
  { nomeOriginal: "ATIVO", contaDestino: "Ativo Total", grupoConta: "Ativo Total" },
  { nomeOriginal: "A T I V O", contaDestino: "Ativo Total", grupoConta: "Ativo Total" },
  { nomeOriginal: "ATIVO TOTAL", contaDestino: "Ativo Total", grupoConta: "Ativo Total" },

  // === ATIVO CIRCULANTE ===
  { nomeOriginal: "Circulante", contaDestino: "Ativo Circulante", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Ativo Circulante Total", contaDestino: "Ativo Circulante", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Total do Ativo Circulante", contaDestino: "Ativo Circulante", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "ATIVO CIRCULANTE", contaDestino: "Ativo Circulante", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Ativo Circulante Liquido", contaDestino: "Ativo Circulante", grupoConta: "Ativo Circulante" },

  // === CAIXA E EQUIVALENTES ===
  { nomeOriginal: "Disponibilidades", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Disponibilidade", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Disponivel", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Caixa e Bancos", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Caixa", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Caixa Matriz", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Bancos c/ Movimento", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Contas Bancárias", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Depósitos Bancários", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Banco Caixa Economica Federal", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Banco Conta Movimento", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Banco do Brasil S/A", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Banco Itau S/A", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Cheques em Cobrança", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Bancos", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Aplicações de Liquidez Imediata", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Aplicações Financeiras", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Fundo de Aplicação Financeira", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Ativos Financeiros", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Instrumentos Financeiros", contaDestino: "Caixa e Equivalentes de Caixa", grupoConta: "Ativo Circulante" },

  // === CONTAS A RECEBER ===
  { nomeOriginal: "Créditos a Receber", contaDestino: "Contas a Receber", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Contas a Receber de Clientes", contaDestino: "Contas a Receber", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Duplicatas a Receber", contaDestino: "Contas a Receber", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Clientes A Receber", contaDestino: "Contas a Receber", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Faturas a Receber Líquidas", contaDestino: "Contas a Receber", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Clientes", contaDestino: "Contas a Receber", grupoConta: "Ativo Circulante" },

  // === ESTOQUES ===
  { nomeOriginal: "Estoques - Almoxarifado", contaDestino: "Estoques", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Inventário", contaDestino: "Estoques", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Estoque Geral", contaDestino: "Estoques", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Mercadorias", contaDestino: "Estoques", grupoConta: "Ativo Circulante" },

  // === TRIBUTOS A RECUPERAR ===
  { nomeOriginal: "Créditos Tributários", contaDestino: "Tributos a Recuperar", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Impostos a Recuperar", contaDestino: "Tributos a Recuperar", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Tributos a Compensar", contaDestino: "Tributos a Recuperar", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Pis A Compensar", contaDestino: "Tributos a Recuperar", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Cofins A Compensar", contaDestino: "Tributos a Recuperar", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Irrf A Compensar", contaDestino: "Tributos a Recuperar", grupoConta: "Ativo Circulante" },

  // === OUTROS CRÉDITOS A RECEBER ===
  { nomeOriginal: "Créditos Diversos a Receber", contaDestino: "Outros Créditos a Receber", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Outros Créditos", contaDestino: "Outros Créditos a Receber", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Créditos em Circulação", contaDestino: "Outros Créditos a Receber", grupoConta: "Ativo Circulante" },

  // === DESPESAS ANT. / ADIANTAMENTOS - ATIVO ===
  { nomeOriginal: "Adiantamentos Concedidos", contaDestino: "Despesas Ant. / Adiantamentos - Ativo", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Despesas Antecipadas", contaDestino: "Despesas Ant. / Adiantamentos - Ativo", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Adiantamentos a Terceiros", contaDestino: "Despesas Ant. / Adiantamentos - Ativo", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Adiantamentos a Empregados", contaDestino: "Despesas Ant. / Adiantamentos - Ativo", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Adiantamentos", contaDestino: "Despesas Ant. / Adiantamentos - Ativo", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Adiantamentos A Fornecedores", contaDestino: "Despesas Ant. / Adiantamentos - Ativo", grupoConta: "Ativo Circulante" },

  // === OUTROS ATIVOS CIRCULANTES ===
  { nomeOriginal: "Bens e Valores em Circulação", contaDestino: "Outros Ativos Circulantes", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Produtos em Transito", contaDestino: "Outros Ativos Circulantes", grupoConta: "Ativo Circulante" },
  { nomeOriginal: "Despesas do Exercicio Seguinte", contaDestino: "Outros Ativos Circulantes", grupoConta: "Ativo Circulante" },

  // === ATIVO NÃO CIRCULANTE ===
  { nomeOriginal: "Não Circulante", contaDestino: "Ativo Não Circulante", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Total do Ativo Não Circulante", contaDestino: "Ativo Não Circulante", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Ativo Permanente", contaDestino: "Ativo Não Circulante", grupoConta: "Ativo Não Circulante" },

  // === REALIZÁVEL A LONGO PRAZO ===
  { nomeOriginal: "Ativo Realizável a Longo Prazo", contaDestino: "Realizável a Longo Prazo", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Créditos Realizáveis a Longo Prazo", contaDestino: "Realizável a Longo Prazo", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Depósitos Judiciais de Longo Prazo", contaDestino: "Realizável a Longo Prazo", grupoConta: "Ativo Não Circulante" },

  // === INVESTIMENTOS ===
  { nomeOriginal: "Outros Investimentos", contaDestino: "Investimentos", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Participação Em Outras Empresas", contaDestino: "Investimentos", grupoConta: "Ativo Não Circulante" },

  // === IMOBILIZADO ===
  { nomeOriginal: "Ativo Imobilizado", contaDestino: "Imobilizado", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Propriedade para Investimento", contaDestino: "Imobilizado", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Bens Imóveis", contaDestino: "Imobilizado", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Máquinas e Equipamentos", contaDestino: "Imobilizado", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Veículos", contaDestino: "Imobilizado", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Moveis e Utensilios", contaDestino: "Imobilizado", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Depreciacao Acumulada", contaDestino: "Imobilizado", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "(-) Depreciações/Amortizações Acumuladadas", contaDestino: "Imobilizado", grupoConta: "Ativo Não Circulante" },

  // === INTANGÍVEL ===
  { nomeOriginal: "Projetos e Softwares", contaDestino: "Intangível", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Softwares e Licenças", contaDestino: "Intangível", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Marcas e Patentes", contaDestino: "Intangível", grupoConta: "Ativo Não Circulante" },
  { nomeOriginal: "Ativo Intangível", contaDestino: "Intangível", grupoConta: "Ativo Não Circulante" },

  // === BENS A ALIENAR ===
  { nomeOriginal: "Ativos Mantidos para Venda", contaDestino: "Bens a Alienar", grupoConta: "Ativo Não Circulante" },

  // === ATIVO DIFERIDO ===
  { nomeOriginal: "Diferido", contaDestino: "Ativo Diferido", grupoConta: "Ativo Não Circulante" },

  // === PASSIVO TOTAL ===
  { nomeOriginal: "Total do Passivo", contaDestino: "Passivo Total", grupoConta: "Passivo Total" },
  { nomeOriginal: "Total Geral do Passivo", contaDestino: "Passivo Total", grupoConta: "Passivo Total" },
  { nomeOriginal: "PASSIVO", contaDestino: "Passivo Total", grupoConta: "Passivo Total" },
  { nomeOriginal: "P A S S I V O", contaDestino: "Passivo Total", grupoConta: "Passivo Total" },

  // === PASSIVO CIRCULANTE ===
  { nomeOriginal: "Total do Passivo Circulante", contaDestino: "Passivo Circulante", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "PASSIVO CIRCULANTE", contaDestino: "Passivo Circulante", grupoConta: "Passivo Circulante" },

  // === FORNECEDORES ===
  { nomeOriginal: "Contas a Pagar a Fornecedores", contaDestino: "Fornecedores", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Contas A Pagar", contaDestino: "Fornecedores", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Obrigações a Pagar", contaDestino: "Fornecedores", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Fornecedores Nacionais", contaDestino: "Fornecedores", grupoConta: "Passivo Circulante" },

  // === OBRIGAÇÕES TRABALHISTAS ===
  { nomeOriginal: "Pessoal a Pagar", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Salários e Encargos a Pagar", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Obrigacoes Trabalhistas", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Provisão P/Despesas C/ Pessoal", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Provisões", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Provisão para Férias", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Benefícios a Empregados", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Provisões Trabalhistas", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Pessoal / Encargos", contaDestino: "Obrigações Trabalhistas", grupoConta: "Passivo Circulante" },

  // === OBRIGAÇÕES TRIBUTÁRIAS ===
  { nomeOriginal: "Obrigações Tributárias", contaDestino: "Obrigações Tributárias", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Impostos e Contribuições a Recolher", contaDestino: "Obrigações Tributárias", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Tributos e Encargos Sociais", contaDestino: "Obrigações Tributárias", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Tributos A Recolher", contaDestino: "Obrigações Tributárias", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Obrigações Fiscais", contaDestino: "Obrigações Tributárias", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Obrigacoes Tributarias", contaDestino: "Obrigações Tributárias", grupoConta: "Passivo Circulante" },

  // === EMPRÉSTIMOS E FINANCIAMENTOS - CURTO PRAZO ===
  { nomeOriginal: "Emprestimos Bancarios", contaDestino: "Empréstimos e Financiamentos - Curto Prazo", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Emprestimos e Financiamentos", contaDestino: "Empréstimos e Financiamentos - Curto Prazo", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Empréstimos", contaDestino: "Empréstimos e Financiamentos - Curto Prazo", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Financiamentos", contaDestino: "Empréstimos e Financiamentos - Curto Prazo", grupoConta: "Passivo Circulante" },

  // === EMPRÉSTIMOS - GRUPO-AWARE DUPLICATES FOR PNC ===
  // Same account names but in Passivo Não Circulante → map to long-term equivalents
  { nomeOriginal: "Emprestimos Bancarios", contaDestino: "Empréstimos e Financiamentos - Longo Prazo", grupoConta: "Passivo Não Circulante" },
  { nomeOriginal: "Emprestimos e Financiamentos", contaDestino: "Empréstimos e Financiamentos - Longo Prazo", grupoConta: "Passivo Não Circulante" },
  { nomeOriginal: "Empréstimos", contaDestino: "Empréstimos e Financiamentos - Longo Prazo", grupoConta: "Passivo Não Circulante" },
  { nomeOriginal: "Financiamentos", contaDestino: "Empréstimos e Financiamentos - Longo Prazo", grupoConta: "Passivo Não Circulante" },

  // === PASSIVOS COM PARTES RELACIONADAS - CURTO PRAZO ===
  { nomeOriginal: "Passivos com Partes Relacionadas", contaDestino: "Passivos com Partes Relacionadas - Curto Prazo", grupoConta: "Passivo Circulante" },

  // === PASSIVOS COM PARTES RELACIONADAS - LONGO PRAZO (group-aware duplicate) ===
  { nomeOriginal: "Passivos com Partes Relacionadas", contaDestino: "Passivos com Partes Relacionadas - Longo Prazo", grupoConta: "Passivo Não Circulante" },

  // === DESPESAS ANT. / ADIANTAMENTOS - PASSIVO ===
  { nomeOriginal: "Adiantamento Recebido", contaDestino: "Despesas Ant. / Adiantamentos - Passivo", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Adiantamento De Clientes", contaDestino: "Despesas Ant. / Adiantamentos - Passivo", grupoConta: "Passivo Circulante" },

  // === OUTROS PASSIVOS CIRCULANTES ===
  { nomeOriginal: "Outras Obrigações", contaDestino: "Outros Passivos Circulantes", grupoConta: "Passivo Circulante" },
  { nomeOriginal: "Outras Contas a Pagar", contaDestino: "Outros Passivos Circulantes", grupoConta: "Passivo Circulante" },

  // === PASSIVO NÃO CIRCULANTE ===
  { nomeOriginal: "Passivo Exigivel A Longo Prazo", contaDestino: "Passivo Não Circulante", grupoConta: "Passivo Não Circulante" },
  { nomeOriginal: "Total do Passivo Não Circulante", contaDestino: "Passivo Não Circulante", grupoConta: "Passivo Não Circulante" },
  { nomeOriginal: "Exigível a Longo Prazo", contaDestino: "Passivo Não Circulante", grupoConta: "Passivo Não Circulante" },

  // === EMPRÉSTIMOS E FINANCIAMENTOS - LONGO PRAZO ===
  { nomeOriginal: "Financiamentos de Longo Prazo", contaDestino: "Empréstimos e Financiamentos - Longo Prazo", grupoConta: "Passivo Não Circulante" },
  { nomeOriginal: "Empréstimos de Longo Prazo", contaDestino: "Empréstimos e Financiamentos - Longo Prazo", grupoConta: "Passivo Não Circulante" },

  // === TRIBUTOS DIFERIDOS ===
  { nomeOriginal: "Tributos Diferidos", contaDestino: "Tributos Diferidos - Longo Prazo", grupoConta: "Passivo Não Circulante" },

  // === PARTICIPAÇÃO NOS LUCROS ===
  { nomeOriginal: "PLR a Pagar", contaDestino: "Participação nos Lucros ou Resultados", grupoConta: "Passivo Não Circulante" },

  // === DIVIDENDOS E JUROS SOBRE O CAPITAL PRÓPRIO ===
  { nomeOriginal: "Dividendos a Pagar", contaDestino: "Dividendos e Juros sobre o Capital Próprio", grupoConta: "Passivo Não Circulante" },

  // === PATRIMÔNIO LÍQUIDO ===
  { nomeOriginal: "Total do Patrimônio Líquido", contaDestino: "Patrimônio Líquido", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Patrimonio Liquido", contaDestino: "Patrimônio Líquido", grupoConta: "Patrimônio Líquido" },

  // === CAPITAL SOCIAL ===
  { nomeOriginal: "Capital", contaDestino: "Capital Social", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Capital Social Subscrito", contaDestino: "Capital Social", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Capital Realizado", contaDestino: "Capital Social", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Capital Integralizado", contaDestino: "Capital Social", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Capital Social Integralizado", contaDestino: "Capital Social", grupoConta: "Patrimônio Líquido" },

  // === RESERVAS DE LUCROS ===
  { nomeOriginal: "Reservas", contaDestino: "Reservas de Lucros", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Reserva Legal", contaDestino: "Reservas de Lucros", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Reservas Estatutárias", contaDestino: "Reservas de Lucros", grupoConta: "Patrimônio Líquido" },

  // === LUCROS/PREJUÍZOS ACUMULADOS ===
  { nomeOriginal: "Lucros Ou Prejuizos Acumulados", contaDestino: "Lucros/Prejuízos Acumulados", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Resultados Acumulados", contaDestino: "Lucros/Prejuízos Acumulados", grupoConta: "Patrimônio Líquido" },
  { nomeOriginal: "Lucros Acumulados", contaDestino: "Lucros/Prejuízos Acumulados", grupoConta: "Patrimônio Líquido" },

  // === RESULTADO DO EXERCÍCIO ===
  { nomeOriginal: "Resultado Do Exercicio", contaDestino: "Resultado do Exercício", grupoConta: "Patrimônio Líquido" },
];

async function main() {
  console.log("Seeding account dictionary...");

  let created = 0;
  let skipped = 0;

  for (const entry of BP_SEED) {
    try {
      // Try to find existing entry with same nomeOriginal + tipo + grupoConta + userId=null
      const existing = await prisma.accountDictionary.findFirst({
        where: {
          nomeOriginal: entry.nomeOriginal,
          tipo: "BP",
          grupoConta: entry.grupoConta,
          userId: null,
        },
      });

      if (existing) {
        // Decisão HUMANA vence o seed: entrada promovida pela validação ou
        // cancelada pelo time nunca é revertida pelo arquivo oficial.
        if (existing.revisao === "promovida" || existing.revisao === "cancelada") {
          skipped++;
          continue;
        }
        // Update existing
        await prisma.accountDictionary.update({
          where: { id: existing.id },
          data: {
            contaDestino: entry.contaDestino,
            grupoConta: entry.grupoConta,
          },
        });
        skipped++;
      } else {
        // Create new global entry
        await prisma.accountDictionary.create({
          data: {
            nomeOriginal: entry.nomeOriginal,
            contaDestino: entry.contaDestino,
            grupoConta: entry.grupoConta,
            tipo: "BP",
            // userId is null for global entries
          },
        });
        created++;
      }
    } catch (err) {
      console.error(`Error seeding "${entry.nomeOriginal}":`, err);
      skipped++;
    }
  }

  console.log(`Seed complete: ${created} created, ${skipped} skipped (already exist)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
