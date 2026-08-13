/**
 * BANCADA DA TRAVA "valor no nome" (13/08/2026).
 *
 * A trava RECUSA gravação no dicionário: um falso positivo deixa o analista sem
 * conseguir classificar uma conta real e o IBR trava com pendência. Então ela só
 * sobe medida contra o tráfego real — os nomes do dicionário E os nomes que o
 * corpus produz —, exigindo ZERO acusação indevida.
 *
 *   npx tsx scripts/ab-valor-no-nome.ts <assinatura.txt>
 */
import * as fs from "fs";
import { PrismaClient } from "@prisma/client";
import { valorMonetarioNoNome } from "../src/services/valor-no-nome";

const prisma = new PrismaClient();

/** Casos-alvo: o print do dono. Todos DEVEM ser acusados. */
const DEVE_ACUSAR = [
  "RECLAMATORIA TRABALHISTA R$ 20.362,43 R$",
  "PROVISÃO P/ IRPJ E CSLL R$ 104.261,48 R$",
  "PROVISÃO P/ IRPJ E CSLL R$ 189.244,12 R$",
  "RECUPERAÇÃO JUDICIAL R$ 2.187.051,35 R$",
  "RECUPERAÇÃO JUDICIAL R$ 2.491.315,04 R$",
  "ADIANTAMENTO DE CLIENTES R$ 220,00 R$",
  "RECUPERAÇÃO JUDICIAL R$ 2.187.051,35",
  "Cash and equivalents 1,234,567.89",
];

/** Nomes legítimos. NENHUM pode ser acusado — a lista dos revisores adversariais. */
const NAO_PODE_ACUSAR = [
  "PROVISÃO P/ IRPJ E CSLL", "RECUPERAÇÃO JUDICIAL", "RECLAMATORIA TRABALHISTA",
  "13o SALARIO", "DECIMO TERCEIRO SALARIO", "13º SALÁRIO A PAGAR",
  "PIS 1,65%", "COFINS 7,6%", "PIS 1,65 (NAO CUMULATIVO)", "COFINS 7,60 - NAO CUMULATIVO",
  "ISS 5,00 SOBRE SERVICOS", "INSS 11,00 RETIDO NA FONTE", "IRRF 1,50 SOBRE SERVICOS",
  "FGTS 8,00 SOBRE FOLHA", "CSRF 4,65 RETIDA", "SIMPLES NACIONAL ANEXO III 6,00",
  "IPCA + 6,00% A.A.", "IPCA + 6,00 % A.A.", "SELIC 13,75% A.A.", "SELIC 13,75 % A.A.",
  "TAXA SELIC 13,75 A.A.", "CDB 104,5% CDI", "CDI + 2,50% A.A.", "CDI + 2,50 % A.A.",
  "DEBENTURES CDI + 3,25 A.A.", "PARTICIPACAO 50,00 NA COLIGADA",
  "LEI 12.973", "PARCELAMENTO LEI 11.941/09", "REFIS LEI 11.941", "ART. 8o",
  "AGENCIA 0049", "CONTA 12345-6", "EMPRESTIMO CAIXA ECON. 1.495.929",
  "EMPRESTIMOS BB GIRO 856.105.965", "ICMS 12%",
  "Imobilizado (Notas 10,11)", "Partes relacionadas (Notas 12,13)",
  "Emprestimos e financiamentos (Nota 11,12)", "Provisoes (Notas 15,16)",
  "Contas a receber (Notas 5,10)", "Property, plant and equipment (Notes 10,11)",
  "BALANÇO PATRIMONIAL FINDO EM 31 DE DEZEMBRO DE 2024 -  Em R$ 1",
  "DVA - DEMONSTRAÇÃO DO VALOR ADICIONADO   -  Em R$ 1",
  "DISPONIBILIDADES (Em R$ 1.000)", "ATIVO CIRCULANTE (R$ 1.000)",
  "CAPITAL SOCIAL 100.000 ACOES VALOR NOMINAL R$ 1,00",
];

(async () => {
  let erros = 0;
  console.log("— casos-alvo (devem ser recusados) —");
  for (const n of DEVE_ACUSAR) {
    const t = valorMonetarioNoNome(n);
    if (!t) { erros++; console.log(`  FALHA  passou batido: "${n}"`); }
    else console.log(`  ok     "${n}"  →  ${t}`);
  }
  console.log("\n— legítimos (nenhum pode ser recusado) —");
  for (const n of NAO_PODE_ACUSAR) {
    const t = valorMonetarioNoNome(n);
    if (t) { erros++; console.log(`  FALSO POSITIVO  "${n}"  →  ${t}`); }
  }
  if (erros === 0) console.log("  (nenhum acusado)");

  // Tráfego real 1: o dicionário.
  const dic = await prisma.accountDictionary.findMany({ select: { nomeOriginal: true } });
  const nomesDic = [...new Set(dic.map((d) => d.nomeOriginal))];
  const acusadosDic = nomesDic.filter((n) => valorMonetarioNoNome(n));
  console.log(`\ndicionário: ${nomesDic.length} nomes distintos · acusados ${acusadosDic.length}`);
  for (const n of acusadosDic.slice(0, 20)) console.log(`   "${n}" → ${valorMonetarioNoNome(n)}`);

  // Tráfego real 2: a assinatura do corpus (documento|nome|valor).
  const arq = process.argv[2];
  if (arq && fs.existsSync(arq)) {
    const nomes = [...new Set(fs.readFileSync(arq, "utf-8").split("\n").filter(Boolean)
      .map((l) => l.slice(l.indexOf("|") + 1, l.lastIndexOf("|"))))];
    const acusados = nomes.filter((n) => valorMonetarioNoNome(n));
    console.log(`\ncorpus: ${nomes.length} nomes distintos · acusados ${acusados.length}`);
    for (const n of acusados.slice(0, 25)) console.log(`   "${n}" → ${valorMonetarioNoNome(n)}`);
    erros += acusados.length;
  }

  console.log(`\nFALHAS: ${erros}`);
  await prisma.$disconnect();
  process.exit(erros === 0 ? 0 : 1);
})();
