/**
 * Estado de runtime do processo — sinais simples compartilhados entre módulos.
 * seedsRodando: os seeds de boot rodam em processos-filho pesados (~2 min após cada
 * deploy/restart); operações que disputam a RAM do container de 1GB (ex.: seed
 * histórico da CVM) devem esperar eles terminarem.
 */
export const runtimeState = {
  seedsRodando: false,
};
