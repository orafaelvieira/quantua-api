/**
 * AUDITORIA DO ARQUIVO OFICIAL DO DICIONÁRIO (13/08/2026).
 *
 * `prisma/seed-data/account-dictionary.json` é SEED: instala em toda base e é
 * visível a todos os clientes da plataforma. A revisão adversarial achou lá
 * dentro "Bradesco Ag.0049 C/C 0329707-1" — agência e conta de um cliente — e um
 * bloco de linhas de documento em caixa alta anexadas no fim, sinal de que
 * classificação de um IBR voltou para o arquivo curado.
 *
 * A régua aqui é a do PRÓPRIO PRODUTO — as travas que já barram esse tipo de
 * entrada na porta do dicionário. Se a trava recusaria a entrada hoje, ela não
 * pode estar no arquivo que semeia todo mundo.
 *
 *   npx tsx scripts/auditar-seed-dicionario.ts            → relatório
 *   npx tsx scripts/auditar-seed-dicionario.ts --limpar   → reescreve o arquivo sem as reprovadas
 */
import * as fs from "fs";
import * as path from "path";
import { avaliarContaParticular } from "../src/services/conta-particular";
import { avaliaValorNoNome } from "../src/services/valor-no-nome";
import { limparCodigoDoNome } from "../src/services/nome-conta";

const ARQ = path.join(__dirname, "..", "prisma", "seed-data", "account-dictionary.json");
const LIMPAR = process.argv.includes("--limpar");

interface Entrada { nomeOriginal: string; contaDestino: string; grupoConta: string; tipo?: string }

const bruto = JSON.parse(fs.readFileSync(ARQ, "utf-8"));
const lista: Entrada[] = Array.isArray(bruto) ? bruto : bruto.entries ?? bruto.entradas;
if (!Array.isArray(lista)) { console.error("formato inesperado no arquivo"); process.exit(1); }

type Motivo = { i: number; e: Entrada; motivo: string; classe: string };
const reprovadas: Motivo[] = [];

lista.forEach((e, i) => {
  const nome = String(e.nomeOriginal ?? "");
  // 1. LGPD — dado identificável de terceiro. Bloqueio duro na porta.
  const part = avaliarContaParticular(nome, e.grupoConta);
  if (part.bloqueioDuro) { reprovadas.push({ i, e, motivo: part.motivo!, classe: "LGPD" }); return; }
  // 2. Valor do documento dentro do nome — linha lida errada.
  const valor = avaliaValorNoNome(nome);
  if (valor.bloqueado) { reprovadas.push({ i, e, motivo: `valor "${valor.trecho}" no nome`, classe: "VALOR" }); return; }
  // 3. Código do plano de contas colado — chave da EMPRESA, não regra
  //    reutilizável. ATENÇÃO: a régua aqui é limparCodigoDoNome, que NÃO tira o
  //    sinal — "(-) Depreciação Acumulada" é conta REDUTORA legítima e o sinal é
  //    significado contábil. Usar limparNomeConta aqui reprovava 34 entradas
  //    boas (a mesma confusão que inverteu a depreciação no BP em 13/08/2026).
  if (limparCodigoDoNome(nome) !== nome.trim()) {
    reprovadas.push({ i, e, motivo: `código do plano no nome (viraria "${limparCodigoDoNome(nome)}")`, classe: "CÓDIGO" });
  }
});

console.log(`arquivo: ${lista.length} entradas`);
console.log(`reprovadas pelas travas do produto: ${reprovadas.length}`);
const porClasse = new Map<string, number>();
for (const r of reprovadas) porClasse.set(r.classe, (porClasse.get(r.classe) ?? 0) + 1);
for (const [c, q] of porClasse) console.log(`  ${String(q).padStart(3)}  ${c}`);
console.log();
for (const r of reprovadas) console.log(`  [${r.classe}] #${r.i} "${r.e.nomeOriginal}" → ${r.e.contaDestino}  ::  ${r.motivo}`);

// Nomes em CAIXA ALTA: não são reprovados (podem ser legítimos), mas são o
// rastro de classificação de documento voltando para o arquivo. Só reporta.
const caixaAlta = lista.filter((e) => {
  const n = String(e.nomeOriginal ?? "");
  return n.length > 3 && n === n.toUpperCase() && /[A-ZÀ-Þ]/.test(n);
});
console.log(`\nem CAIXA ALTA (só aviso, não reprovado): ${caixaAlta.length}`);
for (const e of caixaAlta.slice(0, 20)) console.log(`   "${e.nomeOriginal}" → ${e.contaDestino}`);

if (LIMPAR && reprovadas.length) {
  const fora = new Set(reprovadas.map((r) => r.i));
  const novo = lista.filter((_, i) => !fora.has(i));
  const saida = Array.isArray(bruto) ? novo : { ...bruto, entries: novo };
  fs.writeFileSync(ARQ, JSON.stringify(saida, null, 2) + "\n", "utf-8");
  console.log(`\narquivo reescrito: ${lista.length} → ${novo.length} entradas`);
}
