// src/memoria.js v8.0
// Memória operacional do produtor — aprende com cada decisão
// A IA lê este módulo antes de gerar qualquer análise personalizada

// ── Buscar memória consolidada ────────────────────────────────
async function buscarMemoria(supabase, perfil_id) {
  const [memRow, ppRow, decisoesRow, metasRow, chatRow] = await Promise.all([
    // Memória calculada
    supabase.from('memoria_produtor').select('*').eq('perfil_id', perfil_id).single(),
    // Perfil inteligente (declarado)
    supabase.from('produtor_perfil').select('*').eq('perfil_id', perfil_id).single(),
    // Últimas 10 decisões com resultado
    supabase.from('decisoes')
      .select('cultura,decisao,score_no_momento,preco_executado,preco_posterior,ganho_perdido,resultado,data_decisao,aprendizado')
      .eq('perfil_id', perfil_id)
      .not('resultado', 'is', null)
      .order('data_decisao', { ascending: false })
      .limit(10),
    // Metas ativas por cultura
    supabase.from('metas_safra')
      .select('cultura,preco_minimo,preco_meta,preco_sonho,volume_total_sc,volume_vendido_sc,volume_travado_sc,volume_aberto_sc,prazo_limite,urgencia')
      .eq('perfil_id', perfil_id)
      .eq('ativa', true),
    // Últimas 5 perguntas do chat (contexto de interesse)
    supabase.from('chat_ia')
      .select('pergunta,criado_em')
      .eq('perfil_id', perfil_id)
      .order('criado_em', { ascending: false })
      .limit(5)
  ]);

  const mem  = memRow.data  || null;
  const pp   = ppRow.data   || null;
  const dec  = decisoesRow.data || [];
  const metas= metasRow.data || [];
  const chat = chatRow.data || [];

  // Calcular taxa de acerto pessoal (seguiu e deu certo)
  const decComResultado = dec.filter(d => d.resultado);
  const decBoas = decComResultado.filter(d => d.resultado === 'bom');
  const taxaAcertoPessoal = decComResultado.length > 0
    ? Math.round(decBoas.length / decComResultado.length * 100)
    : null;

  // Detectar padrões nas últimas decisões
  const padroes = detectarPadroes(dec, pp);

  return {
    tem_memoria:    !!mem || dec.length > 0,
    consolidada:    mem,
    perfil:         pp,
    decisoes_recentes: dec,
    metas_ativas:   metas,
    ultimas_perguntas: chat.map(c => c.pergunta),
    taxa_acerto_pessoal: taxaAcertoPessoal,
    padroes,
  };
}

// ── Detectar padrões de comportamento ────────────────────────
function detectarPadroes(decisoes, pp) {
  if (!decisoes || decisoes.length < 3) {
    return { dados_insuficientes: true, decisoes_registradas: decisoes?.length || 0 };
  }

  const comScore = decisoes.filter(d => d.score_no_momento != null);
  const scoresMedioVenda = comScore.filter(d => ['vendeu','parcial'].includes(d.decisao))
    .map(d => d.score_no_momento);
  const scoresMedioEspera = comScore.filter(d => d.decisao === 'esperou')
    .map(d => d.score_no_momento);

  const mediaScoreVenda = scoresMedioVenda.length
    ? Math.round(scoresMedioVenda.reduce((s,v)=>s+v,0)/scoresMedioVenda.length)
    : null;

  // Tendência de ganho/perda
  const comGanho = decisoes.filter(d => d.ganho_perdido != null);
  const ganhoTotal = comGanho.reduce((s,d) => s + (d.ganho_perdido||0), 0);
  const melhorDec  = comGanho.reduce((m,d) => (!m || d.ganho_perdido > m.ganho_perdido) ? d : m, null);
  const piorDec    = comGanho.reduce((m,d) => (!m || d.ganho_perdido < m.ganho_perdido) ? d : m, null);

  // Cultura favorita (mais decisões)
  const porCultura = {};
  decisoes.forEach(d => { porCultura[d.cultura] = (porCultura[d.cultura]||0) + 1; });
  const culturaFavorita = Object.entries(porCultura).sort(([,a],[,b])=>b-a)[0]?.[0] || null;

  // Frequência de decisão
  if (decisoes.length >= 2) {
    const datas = decisoes.map(d => new Date(d.data_decisao)).sort((a,b)=>b-a);
    const intervalos = [];
    for (let i = 0; i < datas.length-1; i++) {
      intervalos.push((datas[i] - datas[i+1]) / 86400000);
    }
    var frequenciaDias = Math.round(intervalos.reduce((s,v)=>s+v,0)/intervalos.length);
  }

  return {
    dados_insuficientes:  false,
    total_decisoes:       decisoes.length,
    score_medio_venda:    mediaScoreVenda,    // com que score costuma vender?
    cultura_mais_ativa:   culturaFavorita,
    frequencia_media_dias:frequenciaDias || null,
    ganho_total_estimado: comGanho.length > 0 ? Math.round(ganhoTotal) : null,
    melhor_decisao: melhorDec ? {
      cultura: melhorDec.cultura, decisao: melhorDec.decisao,
      ganho: Math.round(melhorDec.ganho_perdido), data: melhorDec.data_decisao
    } : null,
    pior_decisao: piorDec ? {
      cultura: piorDec.cultura, decisao: piorDec.decisao,
      perda: Math.round(piorDec.ganho_perdido), data: piorDec.data_decisao
    } : null,
  };
}

// ── Gerar contexto para o prompt da IA ───────────────────────
// Texto compacto que vai no system prompt — sem repetir dados de mercado
function gerarContextoIA(memoria, cultura = null) {
  const { consolidada: mem, perfil: pp, decisoes_recentes, metas_ativas, padroes } = memoria;

  const linhas = [];

  // Perfil declarado
  if (pp) {
    linhas.push(`PERFIL DO PRODUTOR:`);
    if (pp.objetivo)       linhas.push(`- Objetivo: ${pp.objetivo.replace(/_/g,' ')}`);
    if (pp.perfil_risco)   linhas.push(`- Perfil de risco: ${pp.perfil_risco}`);
    if (pp.divida_ativa)   linhas.push(`- ⚠️ Dívida ativa: sim — maior urgência de caixa`);
    if (pp.precisa_caixa)  linhas.push(`- Precisa de caixa: sim`);
    const cultData = cultura && pp.culturas?.[cultura];
    if (cultData?.custo_saca)    linhas.push(`- Custo/saca ${cultura}: R$ ${cultData.custo_saca}`);
    if (cultData?.estoque_atual) linhas.push(`- Estoque atual ${cultura}: ${cultData.estoque_atual.toLocaleString('pt-BR')} sacas`);
  }

  // Memória calculada (comportamento observado)
  if (mem) {
    linhas.push(`\nCOMPORTAMENTO OBSERVADO (${mem.total_decisoes || 0} decisões):`);
    if (mem.taxa_adesao_pct != null) {
      linhas.push(`- Segue recomendações: ${mem.taxa_adesao_pct}% das vezes`);
    }
    if (mem.perfil_velocidade) {
      linhas.push(`- Velocidade de decisão: ${mem.perfil_velocidade}` +
        (mem.tempo_medio_decisao_dias ? ` (média ${Math.round(mem.tempo_medio_decisao_dias)} dias)` : ''));
    }
    if (mem.vende_na_alta != null) {
      linhas.push(`- ${mem.vende_na_alta ? 'Tende a vender quando score está alto (>65)' : 'Vende independentemente do score'}`);
    }
    if (mem.ganho_total_estimado) {
      linhas.push(`- Resultado acumulado estimado: R$ ${Math.round(mem.ganho_total_estimado).toLocaleString('pt-BR')}`);
    }
    if (mem.resumo_ia) linhas.push(`\nRESUMO: ${mem.resumo_ia}`);
  } else if (!padroes?.dados_insuficientes) {
    // Padrões detectados sem memória consolidada ainda
    linhas.push(`\nPADRÕES DETECTADOS (${padroes.total_decisoes} decisões):`);
    if (padroes.score_medio_venda) linhas.push(`- Tende a vender com score médio de ${padroes.score_medio_venda}/100`);
    if (padroes.frequencia_media_dias) linhas.push(`- Toma decisões a cada ~${padroes.frequencia_media_dias} dias`);
  } else {
    linhas.push(`\nMEMÓRIA: Produtor novo — sem histórico de decisões. Adotar abordagem introdutória.`);
  }

  // Últimas decisões (contexto imediato)
  const decRecentes = decisoes_recentes?.filter(d => !cultura || d.cultura === cultura).slice(0, 3);
  if (decRecentes?.length > 0) {
    linhas.push(`\nÚLTIMAS DECISÕES${cultura ? ` (${cultura})` : ''}:`);
    decRecentes.forEach(d => {
      linhas.push(`- ${d.data_decisao}: ${d.decisao} | score=${d.score_no_momento || 'N/D'} | resultado=${d.resultado || 'pendente'}`
        + (d.ganho_perdido ? ` | R$ ${Math.round(d.ganho_perdido).toLocaleString('pt-BR')}` : ''));
      if (d.aprendizado) linhas.push(`  Nota do produtor: "${d.aprendizado}"`);
    });
  }

  // Metas da safra (cultura específica)
  const metaCultura = cultura
    ? metas_ativas?.find(m => m.cultura === cultura)
    : metas_ativas?.[0];
  if (metaCultura) {
    linhas.push(`\nMETA DE SAFRA (${metaCultura.cultura}):`);
    if (metaCultura.preco_meta)    linhas.push(`- Preço meta: R$ ${metaCultura.preco_meta.toLocaleString('pt-BR')}/saca`);
    if (metaCultura.preco_minimo)  linhas.push(`- Preço mínimo: R$ ${metaCultura.preco_minimo.toLocaleString('pt-BR')}/saca`);
    if (metaCultura.volume_aberto_sc != null) linhas.push(`- Volume ainda em aberto: ${metaCultura.volume_aberto_sc.toLocaleString('pt-BR')} sacas`);
    if (metaCultura.prazo_limite)  linhas.push(`- Prazo limite: ${new Date(metaCultura.prazo_limite).toLocaleDateString('pt-BR')}`);
    if (metaCultura.urgencia !== 'normal') linhas.push(`- ⚠️ Urgência: ${metaCultura.urgencia.toUpperCase()}`);
  }

  return linhas.join('\n');
}

// ── Atualizar memória via RPC ─────────────────────────────────
async function atualizarMemoria(supabase, perfil_id) {
  try {
    const { data, error } = await supabase.rpc('atualizar_memoria', { p_perfil_id: perfil_id });
    if (error) console.warn('atualizar_memoria RPC:', error.message);
    return data;
  } catch (e) {
    console.warn('atualizar_memoria:', e.message);
    return null;
  }
}

// ── Registrar evento de aprendizado ──────────────────────────
async function registrarAprendizado(supabase, perfil_id, tipo, conteudo, impacto = null) {
  await supabase.from('eventos_aprendizado').insert({
    perfil_id, tipo, conteudo, impacto
  }).catch(e => console.warn('registrarAprendizado:', e.message));
}

// ── Salvar/atualizar meta de safra ───────────────────────────
async function salvarMeta(supabase, perfil_id, metaData) {
  const { cultura, safra, preco_minimo, preco_meta, preco_sonho,
    volume_total_sc, prazo_limite, urgencia, observacoes } = metaData;

  const { data, error } = await supabase.from('metas_safra').upsert({
    perfil_id, cultura, safra, preco_minimo, preco_meta, preco_sonho,
    volume_total_sc, prazo_limite, urgencia: urgencia || 'normal',
    observacoes, ativa: true,
    atualizado_em: new Date().toISOString()
  }, { onConflict: 'perfil_id,cultura,safra' }).select().single();

  if (!error) {
    await registrarAprendizado(supabase, perfil_id, 'meta_atualizada',
      { cultura, safra, preco_meta, volume_total_sc, prazo_limite },
      `Meta de ${cultura} safra ${safra} definida`
    );
  }

  return { data, error };
}

// ── Atualizar volume vendido/travado na meta ──────────────────
async function atualizarVolumeMeta(supabase, perfil_id, cultura, safra, tipo, volume) {
  const campo = tipo === 'vendido' ? 'volume_vendido_sc' : 'volume_travado_sc';
  await supabase.from('metas_safra')
    .update({ [campo]: volume, atualizado_em: new Date().toISOString() })
    .eq('perfil_id', perfil_id)
    .eq('cultura', cultura)
    .eq('safra', safra);
}

module.exports = {
  buscarMemoria,
  gerarContextoIA,
  atualizarMemoria,
  registrarAprendizado,
  salvarMeta,
  atualizarVolumeMeta,
  detectarPadroes,
};
