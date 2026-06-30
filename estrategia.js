// src/estrategia.js v5.0
// Gera recomendação personalizada com alocação: Vender / Travar / Esperar
// Cada produtor recebe decisão diferente mesmo com o mesmo preço

const { calcularTodosHorizontes } = require('./probabilidade');

// Market Timing Score — índice 0-100 unificado
function calcularMarketTimingScore(score9var, probabilidades) {
  const { horizonte_7d, horizonte_15d } = probabilidades;

  // Combinar score técnico (70%) com probabilidade (30%)
  const probScore = (
    (horizonte_7d.prob_alta * 0.4) +
    (horizonte_15d.prob_alta * 0.6)
  );

  const mts = Math.round(score9var * 0.70 + probScore * 0.30);

  let classificacao, emoji, descricao;
  if (mts >= 85)      { classificacao = 'excelente';  emoji = '🏆'; descricao = 'Momento excepcional — agir imediatamente'; }
  else if (mts >= 70) { classificacao = 'bom';         emoji = '🟢'; descricao = 'Bom momento — considerar venda/travagem'; }
  else if (mts >= 50) { classificacao = 'neutro';      emoji = '🟡'; descricao = 'Mercado neutro — aguardar sinal'; }
  else if (mts >= 30) { classificacao = 'ruim';        emoji = '🟠'; descricao = 'Condições desfavoráveis — cautela'; }
  else                { classificacao = 'evitar';      emoji = '🔴'; descricao = 'Evitar venda agora'; }

  return { score: mts, classificacao, emoji, descricao };
}

// Gerar estratégia personalizada por produtor
function gerarEstrategia(params) {
  const {
    cultura,
    score9var,          // score das 9 variáveis
    probabilidades,     // resultado calcularTodosHorizontes
    // Perfil do produtor
    objetivo,           // maximizar_preco | minimizar_risco | liquidez_rapida | travamento
    perfilRisco,        // conservador | moderado | arrojado
    dividaAtiva,
    precisaCaixa,
    sacasEstoque,       // total em estoque
    custoProd,
    precoAtual,
    dolar,
    // Contexto
    climaImpacto,
    estoqueStatus
  } = params;

  const mts = calcularMarketTimingScore(score9var, probabilidades);
  const { horizonte_15d, horizonte_30d } = probabilidades;

  // ── Calcular margem atual ──────────────────────────────────
  const margem = custoProd && precoAtual
    ? ((precoAtual - custoProd) / custoProd * 100)
    : null;

  // ── Lógica de alocação base pelo MTS ──────────────────────
  let baseVender = 0, baseTravar = 0, baseAguardar = 0;

  if (mts.score >= 85) {
    // Excelente — vender mais agressivamente
    baseVender = 40; baseTravar = 35; baseAguardar = 25;
  } else if (mts.score >= 70) {
    // Bom — vender parte, travar parte
    baseVender = 25; baseTravar = 40; baseAguardar = 35;
  } else if (mts.score >= 50) {
    // Neutro — travagem defensiva
    baseVender = 10; baseTravar = 30; baseAguardar = 60;
  } else if (mts.score >= 30) {
    // Ruim — mínimo necessário
    baseVender = 5; baseTravar = 15; baseAguardar = 80;
  } else {
    // Evitar — só se obrigado
    baseVender = 0; baseTravar = 10; baseAguardar = 90;
  }

  // ── Ajustes por perfil do produtor ────────────────────────
  let ajusteVender = 0, ajusteTravar = 0;
  const riscos = [];
  const oportunidades = [];
  const motivos = [];

  // Necessidade financeira — sempre eleva venda/travagem
  if (dividaAtiva || precisaCaixa) {
    ajusteVender += 15;
    motivos.push('Necessidade de caixa recomenda maior percentual de venda');
  }

  // Objetivo do produtor
  if (objetivo === 'liquidez_rapida') {
    ajusteVender += 20; ajusteTravar -= 10;
    motivos.push('Objetivo de liquidez rápida — priorizar venda imediata');
  } else if (objetivo === 'travamento') {
    ajusteVender -= 10; ajusteTravar += 20;
    motivos.push('Objetivo de travagem — fixar preço para planejamento financeiro');
  } else if (objetivo === 'minimizar_risco') {
    ajusteTravar += 15;
    motivos.push('Perfil conservador — travagem protege contra quedas futuras');
  }

  // Probabilidade de queda alta — urgência
  if (horizonte_15d.prob_queda > 55) {
    ajusteVender += 10;
    riscos.push(`Probabilidade de queda em 15 dias: ${horizonte_15d.prob_queda}%`);
  }

  // Probabilidade de alta — incentivar espera
  if (horizonte_30d.prob_alta > 65 && !dividaAtiva) {
    ajusteAguardar = 10; ajusteVender -= 8;
    oportunidades.push(`Alta probabilidade de valorização em 30 dias: ${horizonte_30d.prob_alta}%`);
  }

  // Margem alta — momento ideal para vender
  if (margem > 30) {
    oportunidades.push(`Excelente margem de ${margem.toFixed(1)}% sobre o custo`);
    ajusteVender += 8;
  } else if (margem !== null && margem < 10) {
    riscos.push(`Margem estreita: ${margem.toFixed(1)}% — monitorar custos`);
  }

  // Câmbio e estoques
  if (estoqueStatus === 'apertado') {
    oportunidades.push('Estoques mundiais apertados sustentam preços');
  }
  if (climaImpacto === 'positivo') {
    oportunidades.push('Clima desfavorável em regiões produtoras reduz oferta');
  }

  // ── Calcular alocação final ────────────────────────────────
  let vender  = Math.max(0, baseVender  + ajusteVender);
  let travar  = Math.max(0, baseTravar  + ajusteTravar);
  let aguardar = Math.max(0, baseAguardar);

  // Normalizar para 100%
  const total = vender + travar + aguardar;
  if (total > 0 && total !== 100) {
    const fator = 100 / total;
    vender   = Math.round(vender * fator);
    travar   = Math.round(travar * fator);
    aguardar = 100 - vender - travar;
  }

  // Garantir que soma = 100
  aguardar = Math.max(0, 100 - vender - travar);

  // Motivo principal
  if (motivos.length === 0) {
    if (mts.score >= 70) motivos.push(`Score ${mts.score}/100 — ${mts.descricao}`);
    else motivos.push(`Market Timing Score ${mts.score}/100 — aguardar melhor momento`);
  }

  // Número de sacas sugeridas
  const sacasVender  = sacasEstoque ? Math.round(sacasEstoque * vender / 100) : null;
  const sacasTravar  = sacasEstoque ? Math.round(sacasEstoque * travar / 100) : null;
  const sacasAguardar = sacasEstoque ? sacasEstoque - (sacasVender||0) - (sacasTravar||0) : null;

  // Confiança da estratégia
  const confianca = Math.round(
    (mts.score > 70 || mts.score < 30 ? 80 : 60) *
    (probabilidades.horizonte_15d.confianca / 100)
  );

  return {
    // Alocação
    pct_vender_agora: vender,
    pct_travar: travar,
    pct_aguardar: aguardar,
    // Em sacas
    sacas_vender: sacasVender,
    sacas_travar: sacasTravar,
    sacas_aguardar: sacasAguardar,
    // Análise
    market_timing: mts,
    motivo_principal: motivos[0] || mts.descricao,
    todos_motivos: motivos,
    riscos,
    oportunidades,
    confianca,
    margem_atual: margem ? parseFloat(margem.toFixed(1)) : null,
    // Probabilidades resumidas
    probabilidade_15d: {
      alta: horizonte_15d.prob_alta,
      queda: horizonte_15d.prob_queda,
      interpretacao: horizonte_15d.interpretacao
    },
    // Resumo textual
    resumo: gerarResumoTextual(vender, travar, aguardar, motivos, riscos, oportunidades, mts, cultura)
  };
}

function gerarResumoTextual(vender, travar, aguardar, motivos, riscos, oportunidades, mts, cultura) {
  const partes = [];

  if (vender > 0 || travar > 0) {
    partes.push(`Recomendação: ${vender > 0 ? `vender ${vender}%` : ''}`
      + `${vender > 0 && travar > 0 ? ', ' : ''}${travar > 0 ? `travar ${travar}%` : ''}`
      + `${aguardar > 0 ? ` e aguardar ${aguardar}%` : ''}.`);
  } else {
    partes.push(`Aguardar — não é momento favorável para comercializar.`);
  }

  if (motivos.length > 0) partes.push(`Motivo: ${motivos[0]}`);
  if (riscos.length > 0)  partes.push(`Atenção: ${riscos[0]}`);
  if (oportunidades.length > 0) partes.push(`Oportunidade: ${oportunidades[0]}`);

  return partes.join(' ');
}

module.exports = { gerarEstrategia, calcularMarketTimingScore };
