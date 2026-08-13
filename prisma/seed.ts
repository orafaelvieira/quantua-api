/**
 * SEED APOSENTADO (13/08/2026) — este arquivo não escreve mais no dicionário.
 *
 * Ele carregava um BP_SEED de 141 entradas HARDCODED e estava ligado ao hook
 * `prisma.seed` do package.json, então disparava em `npm run db:seed`,
 * `prisma migrate dev` e `prisma migrate reset`. Simulado contra a base real,
 * ele TROCARIA o destino de 56 contas globais e criaria 6 — entre elas
 * "Depreciacao Acumulada" e "(-) Depreciações/Amortizações Acumuladadas" saindo
 * de "(-) Depreciação" para "Imobilizado", isto é, conta REDUTORA virando ativo
 * positivo no balanço. Sem trava, sem aprovação humana e sem registro no
 * changelog do dicionário.
 *
 * A fonte da verdade do dicionário global é UMA:
 *   prisma/seed-data/account-dictionary.json  →  prisma/import-dictionary.ts
 * que roda no boot (src/server.ts, runStartupSeeds) e passa pelas travas do
 * produto (LGPD e valor no nome). Base nova nasce populada na primeira partida
 * do servidor — não é preciso semear aqui.
 *
 * O arquivo continua existindo, e não vazio, porque o hook do Prisma o chama: se
 * ele sumir, `prisma migrate reset` quebra. Ele agora só avisa.
 */

console.log(
  [
    "[seed] Este seed foi APOSENTADO e não escreve no dicionário.",
    "[seed] O dicionário global vem de prisma/seed-data/account-dictionary.json,",
    "[seed] aplicado por prisma/import-dictionary.ts (roda sozinho no boot da API).",
    "[seed] Para aplicar agora:  npm run db:seed:dictionary",
  ].join("\n"),
);
