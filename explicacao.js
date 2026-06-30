// src/explicacao.js v10.0
// Módulo de explicabilidade da IA e perfil comportamental do produtor
// "Por que a IA recomenda isso?" — resposta clara, sem jargão

const MOTIVOS_DECISAO = [
  { id: 'preco_bom',       label: 'Preço considerado bom',             aprendizado: true  },
  { id: 'necessidade_cx',  label: 'Necessidade de caixa',              aprendizado: false },
  { id: 'medo_queda',      label: 'Medo de queda no preço',           aprendizado: true  },
  { id: 'recomendacao_ia', label: 'Recomendação da IA',               aprendizado: true  },
  { id: 'contrato',        label: 'Contrato fechado antecipadamente',  aprendizado: false },
  { id: 'cliente_exigiu',  label: 'Cliente/frigorífico/usina exigiu', aprendizado: false },
  { id: 'outro',           label: 'Outro motivo',                      aprendizado: false },
];

// Classificação do motivo para aprendizado do modelo
function motivoAfetaModelo(motivo_id) {
  const m = MOTIVOS_DECISAO.find(m => m.id === motivo_id);
  return m?.aprendizado ?? false;
}

// ── Perfil comportamental do produtor ────────────────────────
function calcularPerfilDecisao(decisoes, memoria) {
  if (!decisoes || decisoes.length < 3) {
    return {
      tipo: 'sem_dados',
      label: 'Perfil em formação',
      descricao: `Registre ${Math.max(0, 3 - (decisoes?.length||0))} decisão(ões) para ver seu perfil.`,
      decisoes_total: decisoes?.length || 0,
    };
  }

  // Análise dos motivos de decisão
  const comMotivo  = decisoes.filter(d => d.motivo_externo);
  const semMotivo  = decisoes.filter(d => !d.motivo_externo);
  const vendeuComIA= decisoes.filter(d => d.motivo_externo === 'recomendacao_ia' || d.seguiu_recomendacao);
  const vendeuMedo = decisoes.filter(d => d.motivo_externo === 'medo_queda');
  const vendeuForca= decisoes.filter(d => ['cliente_exigiu','contrato','necessidade_cx'].includes(d.motivo_externo));

  // Score médio quando vendeu
  const scoresVenda = decisoes
    .filter(d => ['vendeu','parcial','travou'].includes(d.decisao) && d.score_no_momento)
    .map(d => d.score_no_momento);
  const scoreMedioVenda = scoresVenda.length
    ? Math.round(scoresVenda.reduce((s,v) => s+v, 0) / scoresVenda.length)
    : null;

  // Resultado médio
  const comResultado = decisoes.filter(d => d.ganho_perdido != null);
  const ganhoMedio   = comResultado.length
    ? Math.round(comResultado.reduce((s,d) => s+(d.ganho_perdido||0), 0) / comResultado.length)
    : null;

  // Calcular taxa de adesão à IA
  const taxaAdesao = memoria?.taxa_adesao_pct;
  const velocidade = memoria?.perfil_velocidade;

  // ── Determinar tipo de perfil ─────────────────────────────
  let tipo, label, descricao, dica;

  const pctForca = vendeuForca.length / decisoes.length;
  const pctMedo  = vendeuMedo.length  / decisoes.length;
  const pctIA    = vendeuComIA.length / decisoes.length;

  if (pctForca > 0.5) {
    tipo  = 'reativo_externo';
    label = 'Produtor condicionado externamente';
    descricao = 'A maioria das suas vendas acontece por demanda externa (cliente, contrato, caixa). '
      + 'O AgroVenda pode ajudar a se preparar antes dessas janelas.';
    dica = 'Configure alertas de preço para agir preventivamente antes que o cliente exija.';

  } else if (pctMedo > 0.35) {
    tipo  = 'avesso_risco';
    label = 'Produtor avesso ao risco';
    descricao = 'Você tende a vender quando sente risco de queda, mesmo que o mercado ainda favoreça esperar. '
      + 'Estratégia válida para quem prioriza segurança sobre maximização.';
    dica = 'Considere travar preço em vez de vender: protege contra queda sem perder a alta.';

  } else if (pctIA > 0.6 && taxaAdesao > 70) {
    tipo  = 'orientado_ia';
    label = 'Produtor orientado por dados';
    descricao = 'Você segue as recomendações com frequência e usa a IA como referência central. '
      + 'Isso indica disciplina analítica — continue avaliando se os resultados confirmam a estratégia.';
    dica = 'Registre seus resultados para ver se a aderência à IA está gerando retorno acima da média.';

  } else if (scoreMedioVenda && scoreMedioVenda > 72) {
    tipo  = 'oportunista';
    label = 'Produtor oportunista';
    descricao = 'Você vende quando o mercado está favorável (score alto). '
      + 'Estratégia que busca maximizar preço nas janelas de oportunidade.';
    dica = 'Combine com travamento parcial para proteger parte da produção nas altas.';

  } else if (scoreMedioVenda && scoreMedioVenda < 55) {
    tipo  = 'orientado_margem';
    label = 'Produtor orientado por margem';
    descricao = 'Você vende quando garante margem suficiente, independentemente do timing de mercado. '
      + 'Estratégia conservadora que prioriza previsibilidade financeira.';
    dica = 'Configure seu preço mínimo nas metas de safra para o sistema alertar quando atingir.';

  } else {
    tipo  = 'moderado';
    label = 'Produtor equilibrado';
    descricao = 'Você equilibra análise de mercado, necessidade financeira e timing. '
      + 'Perfil versátil que se adapta a diferentes cenários.';
    dica = 'Continue usando o score como referência — seu equilíbrio é um ponto forte.';
  }

  return {
    tipo, label, descricao, dica,
    metricas: {
      decisoes_total:       decisoes.length,
      score_medio_venda:    scoreMedioVenda,
      ganho_medio_estimado: ganhoMedio,
      taxa_adesao_ia_pct:   taxaAdesao,
      velocidade_decisao:   velocidade,
      pct_motivo_externo:   Math.round(pctForca * 100),
      pct_medo_queda:       Math.round(pctMedo * 100),
      pct_seguiu_ia:        Math.round(pctIA * 100),
    },
    // Sem julgamento — apenas análise
    nota: 'Este perfil descreve como você decide, não se é certo ou errado. '
      + 'Cada produtor tem realidade e objetivos diferentes.'
  };
}

// ── Explicar uma recomendação específica ─────────────────────
function explicarRecomendacao(scoreResult, probabilidades, dados, cultura, memoria) {
  const { score, classificacao, itens, confianca, percentual_venda } = scoreResult;
  const p15 = probabilidades?.horizonte_15d;
  const p30 = probabilidades?.horizonte_30d;

  // Fatores organizados
  const fatores_positivos = Object.entries(itens)
    .filter(([,v]) => v.status === 'positivo')
    .map(([,v]) => ({ descricao: v.desc, pts: v.pts, max: v.max }));

  const fatores_atencao = Object.entries(itens)
    .filter(([,v]) => v.status === 'negativo')
    .map(([,v]) => ({ descricao: v.desc, pts: v.pts, max: v.max }));

  const fatores_neutros = Object.entries(itens)
    .filter(([,v]) => v.status === 'neutro')
    .map(([,v]) => ({ descricao: v.desc, pts: v.pts, max: v.max }));

  // Cenários possíveis
  const cenarios = [];
  if (p15) {
    cenarios.push({
      nome:    'Cenário favorável (15 dias)',
      prob:    p15.prob_alta,
      impacto: 'Se o preço subir, quem aguardar pode se beneficiar.',
      acao:    'Aguardar parte da produção faz sentido.'
    });
    cenarios.push({
      nome:    'Cenário adverso (15 dias)',
      prob:    p15.prob_queda,
      impacto: 'Se o preço cair, quem vendeu ou travou hoje estará protegido.',
      acao:    'Vender ou travar parte reduz exposição ao risco.'
    });
  }

  // Contexto histórico do produtor
  let contexto_historico = null;
  if (memoria?.consolidada) {
    const m = memoria.consolidada;
    contexto_historico = {
      decisoes_anteriores:  m.total_decisoes,
      taxa_adesao_pct:      m.taxa_adesao_pct,
      resultado_passado:    m.ganho_total_estimado
        ? (m.ganho_total_estimado > 0
            ? `Suas decisões anteriores geraram ganho estimado de R$ ${Math.abs(m.ganho_total_estimado).toLocaleString('pt-BR')}`
            : `Suas decisões anteriores acumularam perda estimada de R$ ${Math.abs(m.ganho_total_estimado).toLocaleString('pt-BR')}`)
        : 'Sem histórico de resultado para comparar ainda.',
      melhor_decisao: m.melhor_decisao,
    };
  }

  // Resumo em linguagem simples (1 parágrafo)
  const positivos_txt = fatores_positivos.slice(0,3).map(f => f.descricao).join('; ');
  const atencao_txt   = fatores_atencao.slice(0,2).map(f => f.descricao).join('; ');

  const resumo_simples =
    `O score de ${score}/100 indica ${
      score>=81?'uma oportunidade de venda':score>=61?'condições favoráveis':score>=41?'mercado neutro':'momento desfavorável'
    }. ` +
    (positivos_txt ? `A favor: ${positivos_txt}. ` : '') +
    (atencao_txt   ? `Atenção: ${atencao_txt}. `   : '') +
    `A confiança de ${confianca}% reflete a qualidade dos dados disponíveis neste momento.`;

  return {
    // Identidade da recomendação
    cultura,
    score,
    classificacao,
    confianca,
    percentual_venda,

    // Resumo em 1 parágrafo (UX: 30 segundos)
    resumo_simples,

    // Detalhes para quem quiser entender mais
    fatores_positivos,
    fatores_atencao,
    fatores_neutros,

    // Probabilidades
    probabilidades: p15 ? {
      alta_15d:  p15.prob_alta,
      queda_15d: p15.prob_queda,
      alta_30d:  p30?.prob_alta,
      queda_30d: p30?.prob_queda,
      interpretacao: p15.interpretacao,
    } : null,

    // Cenários
    cenarios,

    // Contexto do produtor
    contexto_historico,

    // Dados utilizados (transparência)
    dados_utilizados: {
      preco_atual:    dados?.preco_brl,
      media_60d:      dados?.media_60d,
      dolar:          dados?.dolar_ptax,
      clima:          dados?.clima_impacto,
      volatilidade:   dados?.volatilidade_20d,
      fonte:          dados?.fonte,
      data_dado:      dados?.data_dado,
    },

    // Metodologia (auditável)
    metodologia: scoreResult.metodologia,
    versao_algoritmo: scoreResult.versao,

    // Disclaimer (compliance)
    aviso: 'Esta explicação descreve os dados que embasaram a análise. '
      + 'Não representa garantia de resultado. '
      + 'Você é o responsável pela decisão final.',
  };
}

// ── Jornada: linha do tempo de decisões ──────────────────────
async function buscarJornada(supabase, perfil_id, cultura = null) {
  let q = supabase.from('decisoes')
    .select(`
      id, cultura, decisao, quantidade_sacas, preco_executado,
      preco_posterior, ganho_perdido, score_no_momento,
      recomendacao_recebida, motivo_externo, seguiu_recomendacao,
      resultado, aprendizado, data_decisao, criado_em
    `)
    .eq('perfil_id', perfil_id)
    .order('data_decisao', { ascending: false })
    .limit(50);

  if (cultura) q = q.eq('cultura', cultura);

  const { data: decisoes } = await q;
  if (!decisoes?.length) return { eventos: [], total: 0 };

  // Buscar sinais da IA na mesma época para comparação
  const eventos = decisoes.map(d => {
    const seguiu     = d.seguiu_recomendacao;
    const ganhou     = d.ganho_perdido != null && d.ganho_perdido > 0;
    const perdeu     = d.ganho_perdido != null && d.ganho_perdido < 0;
    const externo    = !!d.motivo_externo && d.motivo_externo !== 'recomendacao_ia';
    const motivoLabel= MOTIVOS_DECISAO.find(m => m.id === d.motivo_externo)?.label || d.motivo_externo || null;

    // Narrativa em 1 frase
    const narrativa = [
      d.quantidade_sacas ? `${d.decisao === 'vendeu' ? 'Vendeu' : d.decisao === 'travou' ? 'Travou' : 'Decidiu aguardar'} ${d.quantidade_sacas.toLocaleString('pt-BR')} sacas de ${d.cultura}` : null,
      d.preco_executado  ? `a R$ ${d.preco_executado.toLocaleString('pt-BR')}/saca` : null,
      d.score_no_momento ? `(score ${d.score_no_momento}/100 naquele momento)` : null,
    ].filter(Boolean).join(' ');

    const resultado_narrativa = d.preco_posterior && d.preco_executado
      ? (d.preco_posterior > d.preco_executado
          ? `O preço subiu para R$ ${d.preco_posterior.toLocaleString('pt-BR')} depois — quem esperou ganhou mais.`
          : d.preco_posterior < d.preco_executado
          ? `O preço caiu para R$ ${d.preco_posterior.toLocaleString('pt-BR')} depois — a venda foi acertada.`
          : 'Preço ficou estável depois da decisão.')
      : null;

    return {
      id:              d.id,
      cultura:         d.cultura,
      data:            d.data_decisao,
      decisao:         d.decisao,
      narrativa,
      motivo:          motivoLabel,
      motivo_externo:  externo,
      score_epoca:     d.score_no_momento,
      preco:           d.preco_executado,
      preco_depois:    d.preco_posterior,
      ganho_perdido:   d.ganho_perdido,
      seguiu_ia:       seguiu,
      resultado:       d.resultado,
      resultado_narrativa,
      aprendizado:     d.aprendizado,
      // Emoji de resultado
      emoji: !d.resultado     ? '⏳'
           : ganhou           ? '✅'
           : perdeu           ? '📉'
           : externo          ? '⚡'
           : '➖',
    };
  });

  // Estatísticas da jornada
  const comResultado = eventos.filter(e => e.resultado);
  const ganhos       = comResultado.filter(e => e.ganho_perdido > 0);
  const perdas       = comResultado.filter(e => e.ganho_perdido < 0);
  const totalGanho   = eventos.reduce((s,e) => s+(e.ganho_perdido||0), 0);

  return {
    eventos,
    total:           eventos.length,
    com_resultado:   comResultado.length,
    ganhos:          ganhos.length,
    perdas:          perdas.length,
    neutros:         comResultado.length - ganhos.length - perdas.length,
    ganho_total_estimado: Math.round(totalGanho),
    taxa_ganho_pct:  comResultado.length
      ? Math.round(ganhos.length / comResultado.length * 100)
      : null,
  };
}

module.exports = {
  MOTIVOS_DECISAO,
  motivoAfetaModelo,
  calcularPerfilDecisao,
  explicarRecomendacao,
  buscarJornada,
};
