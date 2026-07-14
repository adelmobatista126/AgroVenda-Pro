// src/validacao.js v7.0
// Sistema de validação real das previsões do motor de IA
// NUNCA inventa números — só lê de sinais_ia + resultados_sinais

const CULTURAS = ['cafe','soja','milho','boi','acucar','algodao','trigo'];
const NOMES = {
  cafe:'Café ☕', soja:'Soja 🌱', milho:'Milho 🌽', boi:'Boi 🐂',
  acucar:'Açúcar 🍬', algodao:'Algodão 🌸', trigo:'Trigo 🌾'
};

// Retorna a frase resumo do tipo "Nos últimos 100 sinais: acerto 72% | erro 28%"
async function resumoUltimosN(supabase, cultura = 'todas', n = 100, horizonte = '15d') {
  const { data, error } = await supabase
    .rpc('validacao_ultimos_n', {
      p_cultura: cultura,
      p_n: n,
      p_horizonte: horizonte
    });

  if (error) throw new Error('validacao_ultimos_n: ' + error.message);
  return data;
}

// Histórico paginado de sinais com resultado
async function historicoPaginado(supabase, { cultura, pagina = 1, porPagina = 50, somenteAvaliados = false }) {
  const offset = (pagina - 1) * porPagina;

  let q = supabase
    .from('validacao_historico')
    .select('*', { count: 'exact' })
    .order('data_sinal', { ascending: false })
    .range(offset, offset + porPagina - 1);

  if (cultura && cultura !== 'todas') q = q.eq('cultura', cultura);
  if (somenteAvaliados) q = q.neq('resultado_principal', 'pendente');

  const { data, count, error } = await q;
  if (error) throw new Error('historicoPaginado: ' + error.message);

  return {
    dados: data || [],
    total: count || 0,
    pagina,
    paginas: Math.ceil((count || 0) / porPagina),
    por_pagina: porPagina
  };
}

// Accuracy por faixa de score (valida se score alto = mais acerto)
async function validacaoPorScore(supabase, cultura = 'todas') {
  const { data, error } = await supabase.rpc('validacao_por_score', { p_cultura: cultura });
  if (error) throw new Error('validacao_por_score: ' + error.message);
  return data || [];
}

// Série temporal mês a mês (evolução do modelo)
async function validacaoMensal(supabase, cultura = null) {
  let q = supabase.from('validacao_mensal').select('*').order('mes', { ascending: false }).limit(24);
  if (cultura) q = q.eq('cultura', cultura);
  const { data, error } = await q;
  if (error) throw new Error('validacaoMensal: ' + error.message);
  return data || [];
}

// Calibração: prob declarada vs realidade
async function calibracao(supabase, cultura = 'todas') {
  const { data, error } = await supabase.rpc('calibracao_modelo', { p_cultura: cultura });
  if (error) throw new Error('calibracao_modelo: ' + error.message);
  return data || [];
}

// Dashboard de validação completo — uma chamada, tudo junto
async function dashboardValidacao(supabase, cultura = 'todas') {
  // Executar em paralelo
  const [resumo100, resumoGeral, porScore, mensal, calib, ultimosSinais] = await Promise.all([
    resumoUltimosN(supabase, cultura, 100, '15d').then(null, () => null),
    supabase.from('validacao_resumo').select('*')
      .eq(cultura !== 'todas' ? 'cultura' : 'horizonte_dias', cultura !== 'todas' ? cultura : 15),
    validacaoPorScore(supabase, cultura).then(null, () => []),
    validacaoMensal(supabase, cultura !== 'todas' ? cultura : null).then(null, () => []),
    calibracao(supabase, cultura).then(null, () => []),
    supabase.from('validacao_historico').select(
      'sinal_id,cultura,data_sinal,score,decisao_sugerida,preco_brl_momento,preco_em_15d,retorno_15d_pct,acerto_15d,resultado_principal,classificacao_resultado'
    ).eq(cultura !== 'todas' ? 'cultura' : 'resultado_principal', cultura !== 'todas' ? cultura : 'acerto')
     .order('data_sinal', { ascending: false }).limit(10)
  ]);

  const resumoView = resumoGeral.data?.[0] || null;

  // Montar dados_insuficientes com contexto claro
  const temDados = resumo100 && !resumo100.dados_insuficientes;

  return {
    cultura,
    dados_suficientes: temDados,
    // Frase principal
    frase: temDados
      ? resumo100.frase_resumo
      : `Dados insuficientes para ${cultura === 'todas' ? 'todas as culturas' : NOMES[cultura] || cultura}. ` +
        `${resumo100?.avaliados || 0} sinais avaliados até agora. ` +
        `Aguarde o sistema acumular histórico real.`,
    // Métricas principais
    ultimos_100: temDados ? {
      avaliados:     resumo100.sinais?.avaliados,
      pendentes:     resumo100.sinais?.pendentes,
      acertos:       resumo100.taxa_acerto?.acertos,
      erros:         resumo100.taxa_acerto?.erros,
      taxa_acerto:   resumo100.taxa_acerto?.pct,
      taxa_erro:     resumo100.taxa_acerto?.pct_erro,
      retorno_medio: resumo100.retorno?.medio_pct,
      melhor_cenario:resumo100.retorno?.melhor_pct,
      pior_cenario:  resumo100.retorno?.pior_pct,
      volatilidade:  resumo100.retorno?.volatilidade_pct,
      periodo:       resumo100.periodo,
    } : null,
    // Por faixa de score
    por_score: porScore,
    // Evolução mensal
    evolucao_mensal: mensal.slice(0, 12),
    // Calibração do modelo
    calibracao: calib,
    // Últimos sinais recentes
    sinais_recentes: ultimosSinais.data || [],
    // Resumo geral da view
    resumo_geral: resumoView,
    // Timestamp
    gerado_em: new Date().toISOString()
  };
}

// Buscar sinal específico com resultado
async function detalhesSinal(supabase, sinalId) {
  const [sinalRow, resultadoRow] = await Promise.all([
    supabase.from('sinais_ia').select('*').eq('id', sinalId).single(),
    supabase.from('resultados_sinais').select('*').eq('sinal_id', sinalId).single()
  ]);

  if (!sinalRow.data) throw new Error('Sinal não encontrado.');

  const s = sinalRow.data;
  const r = resultadoRow.data || null;

  return {
    sinal: {
      id: s.id,
      cultura: s.cultura,
      data: s.data,
      score: s.score,
      market_timing_score: s.market_timing_score,
      probabilidade_alta:  s.probabilidade_alta,
      probabilidade_queda: s.probabilidade_queda,
      confianca:           s.confianca,
      decisao:             s.decisao_sugerida,
      alocacao: { vender: s.pct_vender, travar: s.pct_travar, aguardar: s.pct_aguardar },
      preco_momento:       s.preco_brl_momento,
      dolar_momento:       s.dolar_momento,
      fatores:             s.fatores_usados,
      versao:              s.versao_algoritmo,
    },
    resultado: r ? {
      preco_7d:       r.preco_em_7d,
      preco_15d:      r.preco_em_15d,
      preco_30d:      r.preco_em_30d,
      retorno_7d:     r.retorno_7d_pct,
      retorno_15d:    r.retorno_15d_pct,
      retorno_30d:    r.retorno_30d_pct,
      acerto_7d:      r.acerto_7d,
      acerto_15d:     r.acerto_15d,
      acerto_30d:     r.acerto_30d,
      resultado:      r.resultado_principal,
      avaliado_em:    r.avaliado_em,
    } : { resultado: 'pendente', mensagem: 'Aguardando dados de preço futuro para avaliação.' },
    // Análise do acerto/erro
    analise: r?.resultado_principal === 'pendente' ? null : {
      acertou:     r?.acerto_15d,
      retorno_real: r?.retorno_15d_pct,
      prob_declarada: s.probabilidade_alta,
      erro_calibracao: r?.retorno_15d_pct !== null
        ? parseFloat((s.probabilidade_alta - (r.retorno_15d_pct > 0 ? 100 : 0)).toFixed(1))
        : null,
      comentario: r?.acerto_15d
        ? `✅ Previsão correta. O sinal indicou ${s.decisao_sugerida} com ${s.probabilidade_alta}% de prob. de alta. Resultado: ${r?.retorno_15d_pct?.toFixed(1)}% em 15 dias.`
        : `❌ Previsão incorreta. O sinal indicou ${s.decisao_sugerida}. Resultado: ${r?.retorno_15d_pct?.toFixed(1)}% em 15 dias.`
    }
  };
}

module.exports = {
  resumoUltimosN,
  historicoPaginado,
  validacaoPorScore,
  validacaoMensal,
  calibracao,
  dashboardValidacao,
  detalhesSinal,
};
