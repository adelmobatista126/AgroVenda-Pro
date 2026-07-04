// src/safra.js v5.0
// Planejamento de comercialização por ciclo agrícola
// Especializado em café, soja, milho — cada cultura tem ciclo próprio

const { calcularProbabilidade } = require('./probabilidade');

// Ciclos agrícolas por cultura (Centro-Sul Brasil)
const CICLOS = {
  cafe: {
    meses_colheita: [4, 5, 6, 7],      // Maio-Agosto
    meses_florada: [9, 10, 11],          // Out-Dez
    bienal: true,                         // Produção alternada
    janela_melhor_venda: [0, 1, 2, 3],  // Jan-Abr (pré-colheita)
    prazo_max_estoque_meses: 12,
    unidade: 'saca 60kg',
    obs: 'Café: bienalidade forte. Anos de baixa produção = preços maiores.'
  },
  soja: {
    meses_colheita: [1, 2, 3, 4],
    meses_plantio: [10, 11, 12],
    bienal: false,
    janela_melhor_venda: [9, 10, 11, 12, 0], // Out-Jan (pré-colheita)
    prazo_max_estoque_meses: 6,
    unidade: 'saca 60kg',
    obs: 'Soja: preços caem pós-colheita (Fev-Abr). Vender antecipado ou aguardar Jul-Set.'
  },
  milho: {
    meses_colheita: [2, 3, 4, 5, 7, 8], // 1ª e 2ª safra
    bienal: false,
    janela_melhor_venda: [6, 7, 8, 9],  // Jun-Set
    prazo_max_estoque_meses: 4,
    unidade: 'saca 60kg',
    obs: 'Milho: 2ª safra (Safrinha) domina. Preços mais altos no 2º semestre.'
  },
  boi: {
    meses_colheita: [],                  // contínuo
    bienal: false,
    janela_melhor_venda: [6, 7, 8, 9],  // Jun-Set (entressafra)
    prazo_max_estoque_meses: 2,
    unidade: '@ 15kg',
    obs: 'Boi: entressafra Jun-Set tende a preços mais altos. Seca antecipa oferta.'
  },
};

// Gerar curva de venda para os próximos 12 meses
function gerarCurvaVenda(params) {
  const {
    cultura, safra, producao_prevista_sc, custo_saca,
    preco_atual, dolar, preco_meta,
    perfil_risco = 'moderado',
    objetivo = 'maximizar_preco',
    dividaAtiva = false
  } = params;

  const ciclo = CICLOS[cultura] || CICLOS.soja;
  const agora = new Date();
  const curva = [];

  for (let mes = 0; mes < 12; mes++) {
    const dataRef = new Date(agora.getFullYear(), agora.getMonth() + mes, 1);
    const mesIdx = dataRef.getMonth();
    const mesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][mesIdx];
    const safraLabel = dataRef.toLocaleDateString('pt-BR', { month:'short', year:'2-digit' });

    // Probabilidade de alta neste mês (modelo simplificado)
    const prob = calcularProbabilidade({
      cultura, precoAtual: preco_atual,
      horizonte: (mes + 1) * 30,
      estoqueStatus: 'neutro', climaImpacto: 'neutro'
    });

    // É janela favorável histórica?
    const janelaFavoravel = ciclo.janela_melhor_venda.includes(mesIdx);
    const eColheita = ciclo.meses_colheita.includes(mesIdx);

    // Preço estimado para o mês
    const variacaoEstimada = ((prob.prob_alta - 50) / 100) * 0.02 * (mes + 1);
    const precoEstimado = Math.round((preco_atual || 0) * (1 + variacaoEstimada));

    // Ação recomendada
    let acao, motivoAcao, gatilhoPreco, pctSugerido;

    if (eColheita && mes < 2) {
      acao = 'observar';
      motivoAcao = 'Período de colheita — aguardar definição de oferta';
      pctSugerido = 0;
    } else if (janelaFavoravel && prob.prob_alta >= 55) {
      acao = 'travar';
      motivoAcao = 'Janela histórica favorável — fixar preço';
      pctSugerido = perfil_risco === 'conservador' ? 30 : perfil_risco === 'arrojado' ? 15 : 20;
      gatilhoPreco = preco_meta || Math.round((preco_atual || 0) * 1.05);
    } else if (prob.prob_alta >= 65 && !eColheita) {
      acao = 'vender';
      motivoAcao = `Alta probabilidade de valorização (${prob.prob_alta}%) — aproveitar`;
      pctSugerido = 15;
    } else if (prob.prob_queda >= 55) {
      acao = 'vender';
      motivoAcao = `Risco de queda (${prob.prob_queda}%) — antecipar venda`;
      pctSugerido = dividaAtiva ? 20 : 10;
    } else {
      acao = 'aguardar';
      motivoAcao = 'Mercado neutro — manter posição';
      pctSugerido = 0;
    }

    curva.push({
      mes: safraLabel,
      mes_idx: mesIdx,
      mes_nome: mesNome,
      acao,
      motivo: motivoAcao,
      pct_sugerido: pctSugerido,
      sacas_sugeridas: producao_prevista_sc ? Math.round(producao_prevista_sc * pctSugerido / 100) : null,
      preco_estimado: precoEstimado,
      gatilho_preco: gatilhoPreco || null,
      prob_alta: prob.prob_alta,
      janela_favoravel: janelaFavoravel,
      e_colheita: eColheita,
      emoji: acao === 'vender' ? '💰' : acao === 'travar' ? '🔒' : acao === 'observar' ? '👀' : '⏳'
    });
  }

  // Totais
  const totalPctSugerido = curva.reduce((s,m) => s + (m.pct_sugerido||0), 0);
  const totalSacasSugeridas = curva.reduce((s,m) => s + (m.sacas_sugeridas||0), 0);

  return {
    cultura,
    safra,
    ciclo_info: ciclo.obs,
    producao_prevista_sc,
    custo_saca,
    preco_atual,
    curva,
    resumo: {
      total_pct_sugerido: Math.min(100, totalPctSugerido),
      total_sacas_sugeridas: totalSacasSugeridas,
      receita_estimada: totalSacasSugeridas && preco_atual
        ? Math.round(totalSacasSugeridas * preco_atual) : null,
      lucro_estimado: totalSacasSugeridas && preco_atual && custo_saca
        ? Math.round(totalSacasSugeridas * (preco_atual - custo_saca)) : null,
      meses_acao: curva.filter(m => m.acao !== 'aguardar').length
    }
  };
}

// Gerar recomendação de travamento imediato
function recomendarTravamento(params) {
  const {
    cultura, producao_prevista_sc, preco_atual, custo_saca,
    percentil_historico = 50, // onde o preço atual está no histórico
    prob_queda_30d = 50,
    perfilRisco = 'moderado',
    dividaAtiva = false
  } = params;

  // Lógica de travamento baseada em percentil histórico
  let pctTravar = 0;
  const riscos = [];
  const motivos = [];

  if (percentil_historico >= 85) {
    pctTravar = 50;
    motivos.push(`Preço no percentil ${percentil_historico} histórico — momento raro de alta`);
  } else if (percentil_historico >= 70) {
    pctTravar = 35;
    motivos.push(`Preço acima de ${percentil_historico}% dos dias históricos — bom para travar`);
  } else if (percentil_historico >= 50) {
    pctTravar = 20;
    motivos.push(`Preço na mediana histórica — travagem conservadora adequada`);
  } else {
    pctTravar = 0;
    riscos.push('Preço abaixo da mediana histórica — aguardar melhora antes de travar');
  }

  // Ajuste por risco de queda
  if (prob_queda_30d > 60) {
    pctTravar = Math.min(70, pctTravar + 15);
    riscos.push(`Probabilidade de queda em 30 dias: ${prob_queda_30d}%`);
  }

  // Ajuste por perfil
  if (perfilRisco === 'conservador') pctTravar = Math.min(60, pctTravar + 10);
  if (perfilRisco === 'arrojado')    pctTravar = Math.max(0, pctTravar - 15);
  if (dividaAtiva)                   pctTravar = Math.min(70, pctTravar + 20);

  const sacasTravar = producao_prevista_sc ? Math.round(producao_prevista_sc * pctTravar / 100) : null;
  const margem = custo_saca && preco_atual ? ((preco_atual - custo_saca) / custo_saca * 100) : null;

  return {
    pct_travar_agora: pctTravar,
    sacas_travar: sacasTravar,
    sacas_abertas: producao_prevista_sc ? producao_prevista_sc - (sacasTravar||0) : null,
    motivos,
    riscos,
    margem_atual_pct: margem ? parseFloat(margem.toFixed(1)) : null,
    receita_travada: sacasTravar && preco_atual ? Math.round(sacasTravar * preco_atual) : null,
    lucro_travado: sacasTravar && preco_atual && custo_saca
      ? Math.round(sacasTravar * (preco_atual - custo_saca)) : null,
    plano_tres_partes: pctTravar > 0 ? {
      travar_agora: pctTravar,
      gatilho: Math.min(40, 70 - pctTravar),
      aberto: Math.max(0, 100 - pctTravar - Math.min(40, 70 - pctTravar))
    } : null,
    recomendacao: pctTravar > 0
      ? `Travar ${pctTravar}% (${sacasTravar?.toLocaleString('pt-BR') || 'N/D'} sacas) agora. ${motivos[0] || ''}`
      : `Aguardar melhor momento para travagem. ${riscos[0] || ''}`
  };
}

module.exports = { gerarCurvaVenda, recomendarTravamento, CICLOS };
