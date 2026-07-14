// src/automacao.js v6.0
// Rotina automática: coleta dados reais, gera sinais, avalia backtesting
const cron = require('node-cron');
const fetch = require('node-fetch');
const { coletarTodas, gerarESalvarSinal, backfillHistorico } = require('./coleta');
const { buscarTodosPrecos } = require('./precos');
const { calcularScore } = require('./score');
const { calcularTodosHorizontes } = require('./probabilidade');
const { gerarEstrategia } = require('./estrategia');
const { enfileirar, processarFila, jaEnviouRecentemente } = require('./fila');
const { atualizarTodosEstados } = require('./clima');
const { gerarOportunidades } = require('./radar');
const { dispararBriefingGeral } = require('./agente');

const CULTURAS = ['cafe','soja','milho','boi','acucar','algodao','trigo'];
const NOMES = {
  cafe:'Café ☕',soja:'Soja 🌱',milho:'Milho 🌽',
  boi:'Boi 🐂',acucar:'Açúcar 🍬',algodao:'Algodão 🌸',trigo:'Trigo 🌾'
};

// Ciclo de coleta + geração de sinais (roda 2x ao dia)
async function cicloPrincipal(supabase, anthropicKey) {
  const inicio = Date.now();
  console.log(`\n⏰ ${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})} — Ciclo principal iniciado`);

  try {
    // 1. Coletar dados reais de todas as fontes
    const resultados = await coletarTodas(supabase);
    const comPreco = resultados.filter(r => r.preco_brl);
    console.log(`📊 Preços coletados: ${comPreco.length}/${CULTURAS.length}`);

    // 2. Buscar preços processados (com médias calculadas)
    const precos = await buscarTodosPrecos(supabase);
    if (!precos.dolar) {
      console.warn('Dólar indisponível — abortando geração de sinais');
      return;
    }

    // 3. Gerar e salvar sinal por cultura
    let sinaisGerados = 0;
    for (const cultura of CULTURAS) {
      const p = precos.precos[cultura];
      if (!p?.brl) continue;

      try {
        // Buscar histórico de preços para volatilidade
        const { data: hist } = await supabase
          .from('dados_mercado_historico')
          .select('preco_brl')
          .eq('cultura', cultura)
          .in('fonte', ['CEPEA_ESALQ','YAHOO_CBOT'])
          .order('data', { ascending: false })
          .limit(60);
        const historicoPrecos = (hist||[]).map(h=>h.preco_brl).filter(Boolean);

        // Buscar clima
        const { data: climaData } = await supabase
          .from('clima_previsao')
          .select('impacto_preco')
          .eq('cultura', cultura)
          .gte('data_previsao', new Date().toISOString().split('T')[0])
          .limit(7);
        const pos = (climaData||[]).filter(c=>c.impacto_preco==='positivo').length;
        const neg = (climaData||[]).filter(c=>c.impacto_preco==='negativo').length;
        const climaImpacto = pos>neg?'positivo':neg>pos?'negativo':'neutro';

        const scoreParams = {
          cultura, precoAtual:p.brl, precoMedia60d:p.media60d,
          preco7dAtras:p.preco7dAtras, dolar:precos.dolar,
          dolarMedia30d:precos.dolarMedia30d,
          estoqueStatus:'neutro', volatilidadeAlta:false, climaImpacto,
        };

        const scoreResult = calcularScore(scoreParams);
        const probabilidades = calcularTodosHorizontes({ ...scoreParams, historicoPrecos });
        const estrategia = gerarEstrategia({
          cultura, score9var:scoreResult.score, probabilidades,
          estoqueStatus:'neutro', climaImpacto,
        });

        await gerarESalvarSinal(supabase, cultura, scoreResult, probabilidades, estrategia);
        sinaisGerados++;
      } catch(e) {
        console.warn(`Sinal ${cultura}:`, e.message);
      }
    }
    console.log(`🎯 Sinais gerados: ${sinaisGerados}/${CULTURAS.length}`);

    // 4. Gerar oportunidades do radar
    await gerarOportunidades(supabase, precos);

    const duracao = Math.round((Date.now()-inicio)/1000);
    console.log(`✅ Ciclo concluído em ${duracao}s`);
  } catch (e) {
    console.error('cicloPrincipal:', e.message);
  }
}

// Avaliar sinais pendentes de backtesting (roda diariamente)
async function avaliarBacktesting(supabase) {
  try {
    // Sinais pendentes de avaliação
    const { data: pendentes } = await supabase
      .from('resultados_sinais')
      .select('*, sinais_ia(cultura, data, decisao_sugerida, preco_brl_momento)')
      .eq('resultado_principal', 'pendente')
      .limit(200);

    if (!pendentes?.length) return;

    let avaliados = 0;
    for (const r of pendentes) {
      const sinal = r.sinais_ia;
      if (!sinal) continue;

      const dataBase = new Date(sinal.data);
      const hoje = new Date();
      const diasPassados = Math.floor((hoje - dataBase) / 86400000);

      // Só avaliar se já passaram os dias suficientes
      const horizontes = [
        { dias: 7,  campo: 'preco_em_7d',  retorno: 'retorno_7d_pct',  acerto: 'acerto_7d' },
        { dias: 15, campo: 'preco_em_15d', retorno: 'retorno_15d_pct', acerto: 'acerto_15d' },
        { dias: 30, campo: 'preco_em_30d', retorno: 'retorno_30d_pct', acerto: 'acerto_30d' },
      ];

      const updates = {};
      for (const h of horizontes) {
        if (diasPassados < h.dias || r[h.campo]) continue;

        // Buscar preço na data futura
        const dataFutura = new Date(dataBase);
        dataFutura.setDate(dataFutura.getDate() + h.dias);
        const dataStr = dataFutura.toISOString().split('T')[0];

        const { data: precoDia } = await supabase
          .from('dados_mercado_historico')
          .select('preco_brl')
          .eq('cultura', sinal.cultura)
          .eq('data', dataStr)
          .in('fonte', ['CEPEA_ESALQ','YAHOO_CBOT'])
          .limit(1).single();

        if (!precoDia?.preco_brl || !sinal.preco_brl_momento) continue;

        const retorno = (precoDia.preco_brl - sinal.preco_brl_momento) / sinal.preco_brl_momento * 100;
        const subiu = retorno > 1;
        const caiu  = retorno < -1;

        const decisaoVende = ['vender','travar','parcial'].includes(sinal.decisao_sugerida);
        const acerto = decisaoVende ? caiu : subiu;

        updates[h.campo]  = precoDia.preco_brl;
        updates[h.retorno]= parseFloat(retorno.toFixed(4));
        updates[h.acerto] = acerto;
      }

      if (Object.keys(updates).length === 0) continue;

      // Resultado principal (baseado em 15d)
      if (updates.acerto_15d !== undefined) {
        updates.resultado_principal = updates.acerto_15d ? 'acerto' : 'erro';
        updates.avaliado_em = new Date().toISOString();
      }

      await supabase.from('resultados_sinais').update(updates).eq('id', r.id);
      avaliados++;
    }

    if (avaliados > 0) console.log(`📈 Backtesting: ${avaliados} sinais avaliados`);
  } catch (e) {
    console.error('avaliarBacktesting:', e.message);
  }
}

// Verificar alertas de preço com sinal preditivo
async function verificarAlertas(supabase) {
  try {
    const precos = await buscarTodosPrecos(supabase);
    if (!precos.dolar) return;

    const hoje = new Date().toISOString().split('T')[0];
    const { data: configs } = await supabase
      .from('configuracoes_alertas')
      .select('*, perfis(id,nome,plano,ativo,validade,telegram_bot_token,telegram_chat_id)')
      .eq('alerta_ativo', true);
    if (!configs?.length) return;

    for (const cfg of configs) {
      const p = cfg.perfis;
      if (!p?.ativo || p.validade < hoje) continue;
      const precoAtual = precos.precos[cfg.cultura]?.brl;
      if (!precoAtual || !cfg.preco_alvo || precoAtual < cfg.preco_alvo) continue;
      const jaEnviou = await jaEnviouRecentemente(supabase, p.id, cfg.cultura, 6);
      if (jaEnviou) continue;

      // Buscar sinal mais recente para incluir no alerta
      const { data: sinal } = await supabase
        .from('sinais_ia')
        .select('score,probabilidade_alta,probabilidade_queda,decisao_sugerida,market_timing_score')
        .eq('cultura', cfg.cultura)
        .order('data', { ascending: false })
        .limit(1).single();

      const dp = precos.precos[cfg.cultura];
      const unid = {cafe:'saca',soja:'saca',milho:'saca',boi:'@',acucar:'saca',algodao:'arroba',trigo:'saca'}[cfg.cultura]||'unidade';

      const msg =
        `🚨 <b>ALERTA PREDITIVO — AgroVenda AI</b>\n\n` +
        `${NOMES[cfg.cultura]} atingiu <b>R$ ${precoAtual.toLocaleString('pt-BR')}/${unid}</b>\n` +
        `💵 Dólar PTAX: R$ ${precos.dolar.toFixed(2)}\n\n` +
        (sinal ? (
          `📊 <b>Score: ${sinal.score}/100 | MTS: ${sinal.market_timing_score||'—'}/100</b>\n` +
          `↑ Prob alta 15d: ${sinal.probabilidade_alta||'—'}% | ↓ Queda: ${sinal.probabilidade_queda||'—'}%\n` +
          `🎯 Decisão: ${sinal.decisao_sugerida?.toUpperCase()}\n\n`
        ) : '') +
        `✅ Recomendação: venda <b>${cfg.percentual_venda||30}%</b> da produção\n\n` +
        `⏰ ${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}\n` +
        `<i>AgroVenda Pro AI v6 • CEPEA/ESALQ</i>`;

      if (p.telegram_bot_token && p.telegram_chat_id) {
        await enfileirar(supabase, {
          perfil_id:p.id, tipo:'alerta_preco_'+cfg.cultura,
          mensagem:msg, destino_bot:p.telegram_bot_token, destino_chat:p.telegram_chat_id
        });
      }
      await supabase.from('alertas').insert({
        perfil_id:p.id, cultura:cfg.cultura, tipo:'preco_atingido',
        mensagem:msg, preco_gatilho:precoAtual, telegram_enviado:false
      });
      console.log(`🚨 Alerta: ${p.nome} | ${cfg.cultura} | R$ ${precoAtual}`);
    }
  } catch (e) { console.error('verificarAlertas:', e.message); }
}

function iniciarAutomacao(supabase, anthropicKey) {
  console.log('🤖 AgroVenda AI v6.0 — Automação iniciada');

  // Ciclo principal de coleta + sinais — 6h e 14h Brasília (9h e 17h UTC)
  cron.schedule('0 9,17 * * *', () => cicloPrincipal(supabase, anthropicKey));

  // AI Agent briefing — 8h Brasília (11h UTC)
  cron.schedule('0 11 * * *', async () => {
    const precos = await buscarTodosPrecos(supabase).then(null, ()=>null);
    if (precos) await dispararBriefingGeral(supabase, precos, anthropicKey);
  });

  // Avaliar backtesting — diariamente às 20h Brasília (23h UTC)
  cron.schedule('0 23 * * *', () => avaliarBacktesting(supabase));

  // Alertas de preço — a cada 30 minutos
  cron.schedule('*/30 * * * *', () => verificarAlertas(supabase));

  // Processar fila Telegram — a cada 5 minutos
  cron.schedule('*/5 * * * *', () => processarFila(supabase));

  // Atualizar clima — 2x ao dia
  cron.schedule('0 6,18 * * *', () => atualizarTodosEstados(supabase));

  // Anti-sleep Railway
  const URL = process.env.RAILWAY_URL;
  if (URL) {
    cron.schedule('*/10 * * * *', () => fetch(`${URL}/`,{timeout:5000}).then(null, ()=>{}));
    console.log(`🔔 Anti-sleep → ${URL}`);
  }

  // Inicialização progressiva (sem bloquear o startup)
  setTimeout(() => processarFila(supabase), 5000);
  setTimeout(() => verificarAlertas(supabase), 15000);
  setTimeout(() => cicloPrincipal(supabase, anthropicKey).then(null, e=>console.warn('ciclo:',e.message)), 60000);
  setTimeout(() => atualizarTodosEstados(supabase), 120000);
  setTimeout(() => backfillHistorico(supabase, 1000), 180000); // migrar dados existentes
}

module.exports = { iniciarAutomacao, cicloPrincipal, avaliarBacktesting, verificarAlertas };
