// src/agente.js v7.0
// Analista agrícola diário — pipeline explícito por cultura
// Formato fixo: Cultura / Situação / Probabilidade / Ação / Motivo / Riscos
// Cada cultura gera 1 análise independente — falha em 1 não afeta as outras

const fetch = require('node-fetch');
const { calcularScore, VERSAO } = require('./score');
const { calcularTodosHorizontes } = require('./probabilidade');
const { gerarEstrategia } = require('./estrategia');
const { enfileirar } = require('./fila');
const { enviarWhatsApp } = require('./whatsapp');
const { gerarESalvarSinal } = require('./coleta');
const { buscarMemoria, gerarContextoIA, atualizarMemoria, registrarAprendizado } = require('./memoria');

const NOMES = {
  cafe:'Café', soja:'Soja', milho:'Milho', boi:'Boi Gordo',
  acucar:'Açúcar', algodao:'Algodão', trigo:'Trigo'
};
const UNIDADES = {
  cafe:'saca 60kg', soja:'saca 60kg', milho:'saca 60kg',
  boi:'@ 15kg', acucar:'saca 50kg', algodao:'arroba', trigo:'saca 60kg'
};

// ── Etapa 1: Buscar dados ─────────────────────────────────────
async function etapa_buscarDados(supabase, cultura) {
  const [precoRow, histRow, climaRow, ppRow] = await Promise.all([
    // Preço mais recente
    supabase.from('dados_mercado_historico')
      .select('preco_brl,dolar_ptax,variacao_1d,variacao_7d,variacao_30d,media_7d,media_20d,media_60d,volatilidade_20d,volatilidade_60d,sazonalidade_indice,anomalia_climatica,data,fonte,confiabilidade')
      .eq('cultura', cultura)
      .in('fonte', ['CEPEA_ESALQ', 'CALCULADO'])
      .not('preco_brl', 'is', null)
      .order('data', { ascending: false })
      .limit(1)
      .single(),

    // Histórico para volatilidade real
    supabase.from('dados_mercado_historico')
      .select('preco_brl')
      .eq('cultura', cultura)
      .in('fonte', ['CEPEA_ESALQ', 'YAHOO_CBOT'])
      .not('preco_brl', 'is', null)
      .order('data', { ascending: false })
      .limit(60),

    // Clima das regiões produtoras
    supabase.from('clima_previsao')
      .select('impacto_preco, condicao, precipitacao_mm, data_previsao')
      .eq('cultura', cultura)
      .gte('data_previsao', new Date().toISOString().split('T')[0])
      .order('data_previsao')
      .limit(7),

    // Dólar médio 30d para o score de câmbio
    supabase.from('dados_mercado_historico')
      .select('dolar_ptax')
      .not('dolar_ptax', 'is', null)
      .order('data', { ascending: false })
      .limit(30),
  ]);

  const dado = precoRow.data;
  if (!dado?.preco_brl) return null;

  const historicoPrecos = (histRow.data || []).map(h => h.preco_brl).filter(Boolean);
  const climaImpactos   = climaRow.data || [];
  const dolares30d      = (ppRow.data || []).map(h => h.dolar_ptax).filter(Boolean);

  const pos = climaImpactos.filter(c => c.impacto_preco === 'positivo').length;
  const neg = climaImpactos.filter(c => c.impacto_preco === 'negativo').length;

  return {
    preco_brl:       dado.preco_brl,
    dolar_ptax:      dado.dolar_ptax,
    dolar_media_30d: dolares30d.length
      ? parseFloat((dolares30d.reduce((s,v)=>s+v,0)/dolares30d.length).toFixed(4))
      : null,
    variacao_1d:     dado.variacao_1d,
    variacao_7d:     dado.variacao_7d,
    variacao_30d:    dado.variacao_30d,
    media_7d:        dado.media_7d,
    media_20d:       dado.media_20d,
    media_60d:       dado.media_60d,
    volatilidade_20d:dado.volatilidade_20d,
    volatilidade_60d:dado.volatilidade_60d,
    anomalia_climatica: dado.anomalia_climatica,
    clima_impacto:   pos > neg ? 'positivo' : neg > pos ? 'negativo' : 'neutro',
    historico_precos:historicoPrecos,
    data_dado:       dado.data,
    fonte:           dado.fonte,
    confiabilidade:  dado.confiabilidade,
    dias_historico:  historicoPrecos.length,
  };
}

// ── Etapa 2: Calcular indicadores ─────────────────────────────
function etapa_calcularIndicadores(dados, cultura, perfil = {}) {
  const score = calcularScore({
    cultura,
    precoAtual:    dados.preco_brl,
    precoMedia60d: dados.media_60d,
    preco7dAtras:  dados.media_7d,     // aproximação
    dolar:         dados.dolar_ptax,
    dolarMedia30d: dados.dolar_media_30d,
    custoProd:     perfil.custo_saca || null,
    estoqueStatus: 'neutro',
    volatilidadeAlta: (dados.volatilidade_20d || 0) > 30,
    climaImpacto:  dados.clima_impacto,
    objetivoProd:  perfil.objetivo,
    perfilRisco:   perfil.perfil_risco,
    dividaAtiva:   perfil.divida_ativa,
    precisaCaixa:  perfil.precisa_caixa,
  });

  const probabilidades = calcularTodosHorizontes({
    cultura,
    precoAtual:      dados.preco_brl,
    precoMedia60d:   dados.media_60d,
    preco7dAtras:    dados.media_7d,
    dolar:           dados.dolar_ptax,
    dolarMedia30d:   dados.dolar_media_30d,
    historicoPrecos: dados.historico_precos,
    estoqueStatus:   'neutro',
    climaImpacto:    dados.clima_impacto,
  });

  const estrategia = gerarEstrategia({
    cultura,
    score9var:     score.score,
    probabilidades,
    objetivo:      perfil.objetivo,
    perfilRisco:   perfil.perfil_risco,
    dividaAtiva:   perfil.divida_ativa,
    precisaCaixa:  perfil.precisa_caixa,
    sacasEstoque:  perfil.estoque_atual,
    custoProd:     perfil.custo_saca,
    precoAtual:    dados.preco_brl,
    dolar:         dados.dolar_ptax,
    climaImpacto:  dados.clima_impacto,
    estoqueStatus: 'neutro',
  });

  return { score, probabilidades, estrategia };
}

// ── Etapa 3: Gerar análise com IA ─────────────────────────────
async function etapa_gerarAnalise(dados, indicadores, cultura, perfil, anthropicKey, memoriaTexto = '') {
  const { score, probabilidades, estrategia } = indicadores;
  const p15 = probabilidades.horizonte_15d;
  const p30 = probabilidades.horizonte_30d;
  const nome = NOMES[cultura] || cultura;

  // Variação relativa ao preço atual
  const varMedia60 = dados.media_60d
    ? ((dados.preco_brl - dados.media_60d) / dados.media_60d * 100).toFixed(1)
    : null;

  const sistPrompt =
    `Você é o AgroVenda AI, analista agrícola especializado em mercado brasileiro de commodities.\n` +
    `Responda EXCLUSIVAMENTE no formato JSON abaixo, sem texto fora do JSON.\n` +
    `Seja direto, específico e baseado nos dados fornecidos. Máximo 2 frases por campo.\n` +
    `Use linguagem que um produtor rural entende, sem jargão financeiro excessivo.\n\n` +
    `{"situacao":"...","probabilidade_texto":"...","acao_sugerida":"...","motivo":"...","riscos":"..."}`;

  const dadosPrompt =
    `DADOS REAIS — ${nome} — ${new Date().toLocaleDateString('pt-BR')}\n\n` +
    `Preço atual: R$ ${dados.preco_brl.toLocaleString('pt-BR')} / ${UNIDADES[cultura]}\n` +
    `Fonte: ${dados.fonte} | Data do dado: ${dados.data_dado}\n` +
    `Variação 1 dia: ${dados.variacao_1d != null ? (dados.variacao_1d > 0 ? '+' : '') + dados.variacao_1d.toFixed(2) + '%' : 'N/D'}\n` +
    `Variação 7 dias: ${dados.variacao_7d != null ? (dados.variacao_7d > 0 ? '+' : '') + dados.variacao_7d.toFixed(2) + '%' : 'N/D'}\n` +
    `Variação 30 dias: ${dados.variacao_30d != null ? (dados.variacao_30d > 0 ? '+' : '') + dados.variacao_30d.toFixed(2) + '%' : 'N/D'}\n` +
    `Média 60 dias: R$ ${dados.media_60d?.toLocaleString('pt-BR') || 'N/D'} ${varMedia60 ? `(atual ${varMedia60 > 0 ? '+' : ''}${varMedia60}% acima)` : ''}\n` +
    `Volatilidade 20d: ${dados.volatilidade_20d?.toFixed(1) || 'N/D'}% ao ano\n` +
    `Dólar PTAX: R$ ${dados.dolar_ptax?.toFixed(2) || 'N/D'}\n` +
    `Clima: ${dados.clima_impacto} (${dados.anomalia_climatica || 'normal'})\n\n` +
    `INDICADORES CALCULADOS:\n` +
    `Score: ${score.score}/100 (${score.classificacao})\n` +
    `Market Timing Score: ${estrategia.market_timing?.score}/100\n` +
    `Prob alta 15d: ${p15.prob_alta}% | Prob queda 15d: ${p15.prob_queda}%\n` +
    `Prob alta 30d: ${p30.prob_alta}% | Prob queda 30d: ${p30.prob_queda}%\n` +
    `Estratégia: vender ${estrategia.pct_vender_agora}% / travar ${estrategia.pct_travar}% / aguardar ${estrategia.pct_aguardar}%\n` +
    `Confiança: ${estrategia.confianca}%\n\n` +
    `PERFIL DO PRODUTOR:\n` +
    `Objetivo: ${perfil.objetivo || 'maximizar_preco'} | Risco: ${perfil.perfil_risco || 'moderado'}\n` +
    (perfil.custo_saca ? `Custo/saca: R$ ${perfil.custo_saca}\n` : '') +
    (perfil.estoque_atual ? `Estoque: ${perfil.estoque_atual.toLocaleString('pt-BR')} sacas\n` : '') +
    (perfil.divida_ativa ? `⚠️ Produtor com dívida ativa — maior urgência de liquidez\n` : '') +
    (memoriaTexto ? `\n\n${memoriaTexto}\n` : '') +
    `\nGere a análise no JSON solicitado, considerando o perfil individual do produtor.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: sistPrompt,
        messages: [{ role: 'user', content: dadosPrompt }]
      }),
      timeout: 25000
    });

    const iaData = await res.json();
    const texto = (iaData.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Extrair JSON — remover possível markdown
    const limpo = texto.replace(/```json|```/g, '').trim();
    const analise = JSON.parse(limpo);

    return {
      situacao:             analise.situacao           || '',
      probabilidade_texto:  analise.probabilidade_texto || '',
      acao_sugerida:        analise.acao_sugerida       || '',
      motivo:               analise.motivo              || '',
      riscos:               analise.riscos              || '',
      tokens: (iaData.usage?.input_tokens || 0) + (iaData.usage?.output_tokens || 0),
      gerado_por: 'claude',
    };
  } catch (e) {
    // Fallback: texto gerado por regras se IA falhar
    return gerarAnaliseFallback(dados, indicadores, cultura);
  }
}

// Fallback sem IA — baseado 100% nos indicadores calculados
function gerarAnaliseFallback(dados, indicadores, cultura) {
  const { score, probabilidades, estrategia } = indicadores;
  const p15 = probabilidades.horizonte_15d;
  const nome = NOMES[cultura] || cultura;

  const varMedia60 = dados.media_60d
    ? ((dados.preco_brl - dados.media_60d) / dados.media_60d * 100).toFixed(1)
    : null;

  const situacao = [
    `Preço: R$ ${dados.preco_brl.toLocaleString('pt-BR')}/${UNIDADES[cultura]}.`,
    varMedia60 ? `${varMedia60 > 0 ? 'Acima' : 'Abaixo'} da média 60 dias em ${Math.abs(varMedia60)}%.` : '',
    dados.variacao_7d != null ? `Variação semanal: ${dados.variacao_7d > 0 ? '+' : ''}${dados.variacao_7d.toFixed(1)}%.` : '',
    `Dólar: R$ ${dados.dolar_ptax?.toFixed(2) || 'N/D'}.`,
  ].filter(Boolean).join(' ');

  const probTexto =
    `Alta em 15 dias: ${p15.prob_alta}%. Queda: ${p15.prob_queda}%. ` +
    p15.interpretacao;

  const acao =
    estrategia.pct_vender_agora > 0
      ? `Vender ${estrategia.pct_vender_agora}%${estrategia.pct_travar > 0 ? ` e travar ${estrategia.pct_travar}%` : ''}.`
      : estrategia.pct_travar > 0
      ? `Travar ${estrategia.pct_travar}% do estoque.`
      : 'Aguardar — não é momento ideal para comercializar.';

  return {
    situacao,
    probabilidade_texto: probTexto,
    acao_sugerida:  acao,
    motivo:         estrategia.motivo_principal || score.acao,
    riscos:         estrategia.riscos?.join('. ') || 'Monitorar câmbio e condições climáticas.',
    tokens:         0,
    gerado_por:     'fallback_regras',
  };
}

// ── Etapa 4: Montar mensagem no formato fixo ──────────────────
function etapa_montarMensagem(cultura, dados, indicadores, analise) {
  const { score, probabilidades, estrategia } = indicadores;
  const p15  = probabilidades.horizonte_15d;
  const mts  = estrategia.market_timing;
  const nome = NOMES[cultura] || cultura;
  const unid = UNIDADES[cultura] || 'unidade';

  const emojiMTS = mts.score >= 70 ? '🟢' : mts.score >= 50 ? '🟡' : '🔴';

  // Linha de alocação (só mostra percentuais > 0)
  const alocacao = [
    estrategia.pct_vender_agora > 0 ? `💰 Vender: ${estrategia.pct_vender_agora}%` : null,
    estrategia.pct_travar > 0       ? `🔒 Travar: ${estrategia.pct_travar}%`       : null,
    estrategia.pct_aguardar > 0     ? `⏳ Aguardar: ${estrategia.pct_aguardar}%`   : null,
  ].filter(Boolean).join('  ·  ');

  const varMedia60 = dados.media_60d && dados.preco_brl
    ? ((dados.preco_brl - dados.media_60d) / dados.media_60d * 100).toFixed(1)
    : null;

  return (
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🌾 <b>${nome}</b> — Análise Diária\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +

    `<b>📌 Cultura:</b>\n` +
    `${nome} (${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday:'long', day:'numeric', month:'short' })})\n\n` +

    `<b>📊 Situação:</b>\n` +
    `${analise.situacao}\n\n` +

    `<b>🎲 Probabilidade (15 dias):</b>\n` +
    `${analise.probabilidade_texto}\n` +
    `↑ Alta: <b>${p15.prob_alta}%</b>  |  ↓ Queda: <b>${p15.prob_queda}%</b>\n\n` +

    `<b>🎯 Ação sugerida:</b>\n` +
    `${emojiMTS} <b>${analise.acao_sugerida}</b>\n` +
    `${alocacao}\n\n` +

    `<b>💡 Motivo:</b>\n` +
    `${analise.motivo}\n\n` +

    `<b>⚠️ Riscos:</b>\n` +
    `${analise.riscos}\n\n` +

    `<b>📈 Indicadores:</b>\n` +
    `Score: ${score.score}/100 | MTS: ${mts.score}/100 | Confiança: ${estrategia.confianca}%\n` +
    `Preço: R$ ${dados.preco_brl.toLocaleString('pt-BR')}/${unid}\n` +
    (varMedia60 ? `Vs média 60d: ${varMedia60 > 0 ? '+' : ''}${varMedia60}%\n` : '') +
    `Dólar PTAX: R$ ${dados.dolar_ptax?.toFixed(2) || 'N/D'}\n\n` +

    `<i>CEPEA/ESALQ • AgroVenda AI v7 • ${new Date().toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'})}</i>`
  );
}

// ── Etapa 5: Enviar alerta ─────────────────────────────────────
async function etapa_enviarAlerta(supabase, perfil, mensagem, cultura) {
  const canaisEnviados = [];

  // Telegram
  if (perfil.telegram_bot_token && perfil.telegram_chat_id) {
    await enfileirar(supabase, {
      perfil_id:    perfil.id,
      tipo:         `agente_diario_${cultura}`,
      mensagem,
      destino_bot:  perfil.telegram_bot_token,
      destino_chat: perfil.telegram_chat_id,
    });
    canaisEnviados.push('telegram');
  }

  // WhatsApp (Premium)
  if (perfil.telefone && perfil.plano === 'premium') {
    await enviarWhatsApp(perfil.telefone, mensagem.replace(/<[^>]*>/g, ''));
    canaisEnviados.push('whatsapp');
  }

  return canaisEnviados;
}

// ── PIPELINE COMPLETO POR CULTURA ────────────────────────────
async function analisarCultura(supabase, perfil, ppData, cultura, anthropicKey) {
  const nomeCultura = NOMES[cultura] || cultura;
  const log = (etapa, msg) => console.log(`  [${cultura}] ${etapa}: ${msg}`);

  log('START', `iniciando pipeline`);

  // Perfil da cultura específica
  const cultData = ppData?.culturas?.[cultura] || {};
  const perfil_cultura = {
    objetivo:      ppData?.objetivo      || 'maximizar_preco',
    perfil_risco:  ppData?.perfil_risco  || 'moderado',
    divida_ativa:  ppData?.divida_ativa  || false,
    precisa_caixa: ppData?.precisa_caixa || false,
    custo_saca:    cultData.custo_saca   || null,
    estoque_atual: cultData.estoque_atual|| null,
  };

  // 1. Buscar dados
  log('1/5', 'buscando dados de mercado...');
  const dados = await etapa_buscarDados(supabase, cultura);
  if (!dados) {
    log('1/5', `⚠️  sem dados de preço disponíveis`);
    return null;
  }
  log('1/5', `✅ preço R$ ${dados.preco_brl.toLocaleString('pt-BR')} (${dados.fonte})`);

  // 2. Calcular indicadores
  log('2/5', 'calculando indicadores...');
  const indicadores = etapa_calcularIndicadores(dados, cultura, perfil_cultura);
  log('2/5', `✅ score=${indicadores.score.score}/100 | MTS=${indicadores.estrategia.market_timing?.score}/100 | prob_alta=${indicadores.probabilidades.horizonte_15d.prob_alta}%`);

  // 3. Gerar análise com IA
  log('3/5', 'gerando análise com IA...');
  // Buscar memória do produtor para personalizar a análise
  const supabaseRef = supabase; // referência disponível no escopo
  const [memoriaRow] = await Promise.all([
    supabaseRef.from('memoria_produtor').select('resumo_ia,taxa_adesao_pct,perfil_velocidade,vende_na_alta,melhor_decisao,pior_decisao').eq('perfil_id', perfil.id).single()
  ]);
  const mem = memoriaRow?.data;
  const memoriaTexto = mem?.resumo_ia
    ? `HISTÓRICO DO PRODUTOR: ${mem.resumo_ia}` +
      (mem.taxa_adesao_pct != null ? ` Taxa de adesão: ${mem.taxa_adesao_pct}%.` : '') +
      (mem.vende_na_alta != null ? ` ${mem.vende_na_alta ? 'Costuma vender com mercado favorável.' : 'Às vezes vende mesmo com mercado desfavorável.'}` : '')
    : '';

  const analise = await etapa_gerarAnalise(dados, indicadores, cultura, perfil_cultura, anthropicKey, memoriaTexto);
  log('3/5', `✅ gerado por: ${analise.gerado_por} (${analise.tokens} tokens)`);

  // 4. Montar mensagem formato fixo
  log('4/5', 'montando mensagem...');
  const mensagem = etapa_montarMensagem(cultura, dados, indicadores, analise);
  log('4/5', `✅ ${mensagem.length} chars`);

  // 5. Enviar alerta
  log('5/5', 'enviando alerta...');
  const { telegram_bot_token, telegram_chat_id, telefone, plano } = perfil;
  const canais = await etapa_enviarAlerta(supabase,
    { id: perfil.id, telegram_bot_token, telegram_chat_id, telefone, plano },
    mensagem, cultura
  );
  log('5/5', `✅ enviado via: ${canais.join(', ') || 'nenhum canal configurado'}`);

  // Salvar sinal e estratégia no banco
  await gerarESalvarSinal(supabase, cultura, indicadores.score, indicadores.probabilidades, indicadores.estrategia).catch(() => {});
  // Registrar evento de aprendizado
  await registrarAprendizado(supabase, perfil.id, 'analise_gerada', {
    cultura, score: indicadores.score.score, mts: indicadores.estrategia.market_timing?.score,
    acao: analise.acao_sugerida
  }, null).catch(() => {});

  await supabase.from('estrategias_venda').insert({
    perfil_id:         perfil.id,
    cultura,
    pct_vender_agora:  indicadores.estrategia.pct_vender_agora,
    pct_travar:        indicadores.estrategia.pct_travar,
    pct_aguardar:      indicadores.estrategia.pct_aguardar,
    motivo_principal:  analise.motivo,
    riscos:            [analise.riscos],
    market_timing_score: indicadores.estrategia.market_timing?.score,
    confianca:         indicadores.estrategia.confianca,
    validade:          new Date(Date.now() + 24*3600*1000).toISOString(),
  }).catch(() => {});

  return {
    cultura,
    dados: { preco: dados.preco_brl, dolar: dados.dolar_ptax, fonte: dados.fonte },
    score:         indicadores.score.score,
    mts:           indicadores.estrategia.market_timing?.score,
    prob_alta_15d: indicadores.probabilidades.horizonte_15d.prob_alta,
    estrategia: {
      vender:  indicadores.estrategia.pct_vender_agora,
      travar:  indicadores.estrategia.pct_travar,
      aguardar:indicadores.estrategia.pct_aguardar,
    },
    analise: {
      acao_sugerida: analise.acao_sugerida,
      motivo:        analise.motivo,
    },
    canais_enviados: canais,
    tokens_usados:   analise.tokens,
    gerado_por:      analise.gerado_por,
  };
}

// ── PIPELINE COMPLETO POR PRODUTOR ───────────────────────────
async function gerarBriefingProdutor(supabase, perfil, _precos, anthropicKey) {
  console.log(`\n🤖 Agente: ${perfil.nome} | plano: ${perfil.plano}`);

  // Buscar token Telegram
  const { data: tokData } = await supabase.from('perfis')
    .select('telegram_bot_token, telegram_chat_id, telefone')
    .eq('id', perfil.id).single();

  const perfilCompleto = {
    ...perfil,
    telegram_bot_token: tokData?.telegram_bot_token,
    telegram_chat_id:   tokData?.telegram_chat_id,
    telefone:           tokData?.telefone,
  };

  // Buscar perfil inteligente do produtor
  const { data: ppData } = await supabase.from('produtor_perfil')
    .select('*').eq('perfil_id', perfil.id).single();

  const culturas = (perfil.culturas_interesse || ['cafe','soja','milho']).slice(0, 4);
  const resultados = [];
  let totalTokens = 0;

  // Pipeline independente por cultura
  for (const cultura of culturas) {
    try {
      const resultado = await analisarCultura(
        supabase, perfilCompleto, ppData, cultura, anthropicKey
      );
      if (resultado) {
        resultados.push(resultado);
        totalTokens += resultado.tokens_usados || 0;
      }
    } catch (e) {
      console.error(`  [${cultura}] ❌ Pipeline falhou: ${e.message}`);
      // Continua para a próxima cultura
    }

    // Intervalo entre culturas para não sobrecarregar IA
    await new Promise(r => setTimeout(r, 1200));
  }

  // Mensagem de resumo geral (após todas as culturas)
  if (resultados.length > 0 && perfilCompleto.telegram_bot_token) {
    const dataBR = new Date().toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long'
    });

    const linhasResumo = resultados.map(r => {
      const emoji = r.mts >= 70 ? '🟢' : r.mts >= 50 ? '🟡' : '🔴';
      return `${emoji} <b>${NOMES[r.cultura]}</b>: ${r.analise.acao_sugerida}`;
    }).join('\n');

    const msgResumo =
      `🌾 <b>BOM DIA, ${perfil.nome.split(' ')[0]}!</b>\n` +
      `📅 ${dataBR}\n\n` +
      `<b>Resumo de hoje:</b>\n${linhasResumo}\n\n` +
      `<i>As análises detalhadas de cada cultura foram enviadas acima.</i>\n` +
      `<i>AgroVenda Pro AI v7 • CEPEA/ESALQ</i>`;

    await enfileirar(supabase, {
      perfil_id:    perfil.id,
      tipo:         'agente_resumo_diario',
      mensagem:     msgResumo,
      destino_bot:  perfilCompleto.telegram_bot_token,
      destino_chat: perfilCompleto.telegram_chat_id,
    });
  }

  // Salvar relatório consolidado
  const decisoesSugeridas = resultados.map(r => ({
    cultura:    r.cultura,
    acao:       r.estrategia.vender > 20 ? 'vender' : r.estrategia.travar > 20 ? 'travar' : 'aguardar',
    percentual: Math.max(r.estrategia.vender, r.estrategia.travar),
    motivo:     r.analise.motivo,
    mts:        r.mts,
  }));

  await supabase.from('relatorios_agente').insert({
    perfil_id:          perfil.id,
    data:               new Date().toISOString().split('T')[0],
    tipo:               'diario',
    conteudo:           resultados.map(r => `${NOMES[r.cultura]}: ${r.analise.acao_sugerida}`).join(' | '),
    decisoes_sugeridas: decisoesSugeridas,
    canal_enviado:      [...new Set(resultados.flatMap(r => r.canais_enviados))],
  }).catch(() => {});

  console.log(`  ✅ Briefing concluído: ${resultados.length}/${culturas.length} culturas | ${totalTokens} tokens`);

  return {
    textoBriefing:     resultados.map(r => `${NOMES[r.cultura]}: ${r.analise.acao_sugerida}`).join('\n'),
    msgTelegram:       '',  // já enviada por cultura
    analises:          resultados,
    decisoesSugeridas,
    totalTokens,
  };
}

// ── DISPARO GERAL (todos os assinantes PRO/PREMIUM) ──────────
async function dispararBriefingGeral(supabase, _precos, anthropicKey) {
  const hoje = new Date().toISOString().split('T')[0];
  const BATCH = 10; // menor batch — cada produtor faz N chamadas IA
  let pagina = 0;
  let totalProdutores = 0;
  let totalCulturas   = 0;

  console.log(`\n🌅 ${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})} — AI Agent disparando briefings`);

  while (true) {
    const { data: perfis } = await supabase.from('perfis')
      .select('id, nome, plano, culturas_interesse')
      .eq('ativo', true)
      .gte('validade', hoje)
      .in('plano', ['pro', 'premium'])
      .range(pagina * BATCH, (pagina + 1) * BATCH - 1);

    if (!perfis?.length) break;

    for (const perfil of perfis) {
      try {
        const resultado = await gerarBriefingProdutor(supabase, perfil, null, anthropicKey);
        totalProdutores++;
        totalCulturas += resultado.analises?.length || 0;
      } catch (e) {
        console.error(`  ❌ ${perfil.nome}: ${e.message}`);
      }
      // Intervalo entre produtores — respeitar rate limit da API
      await new Promise(r => setTimeout(r, 2000));
    }

    pagina++;
    if (perfis.length < BATCH) break;
  }

  console.log(`\n✅ AI Agent concluído: ${totalProdutores} produtores | ${totalCulturas} análises`);
  return { totalProdutores, totalCulturas };
}

module.exports = {
  gerarBriefingProdutor,
  dispararBriefingGeral,
  analisarCultura,         // exporta para testes e uso pontual
  etapa_buscarDados,       // exporta para rota manual
  etapa_calcularIndicadores,
  etapa_gerarAnalise,
  etapa_montarMensagem,
};
