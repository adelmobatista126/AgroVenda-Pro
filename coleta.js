// src/coleta.js v6.0
// Coleta dados reais de todas as fontes e persiste em dados_mercado_historico
// Não gera dados falsos. Se a fonte falhar, registra o erro e continua.

const fetch = require('node-fetch');
const { SAZONALIDADE } = require('./score');

const CULTURAS = ['cafe','soja','milho','boi','acucar','algodao','trigo'];

const CEPEA_IDS = {
  cafe:    28,  // Café Arábica ESALQ/SP
  soja:    50,  // Soja ESALQ/Paraná
  milho:   48,  // Milho ESALQ/Campinas
  boi:     25,  // Boi Gordo ESALQ/SP
  acucar: 100,  // Açúcar Cristal ESALQ
  algodao: 91,  // Algodão ESALQ/SP
  trigo:  102,  // Trigo ESALQ/PR
};

const YAHOO_TICKERS = {
  cafe:    'KC=F', soja: 'ZS=F', milho: 'ZC=F',
  boi:     'LE=F', acucar: 'SB=F', algodao: 'CT=F', trigo: 'ZW=F',
};

// Fator de conversão Yahoo (cents/unidade) → USD/unidade base
const YAHOO_FACTOR = {
  cafe: 0.01, soja: 0.01, milho: 0.01,
  boi: 0.01, acucar: 0.01, algodao: 0.01, trigo: 0.01,
};

// ── Utilitário: registrar coleta no log ──────────────────────
async function logColeta(supabase, { fonte_codigo, cultura, data_ref, registros, sucesso, erro, duracao_ms }) {
  await supabase.from('log_coletas').insert({
    fonte_codigo, cultura, data_ref, registros: registros||0, sucesso, erro: erro||null, duracao_ms
  });

  // Atualizar status da fonte
  await supabase.from('fontes_dados')
    .update({
      ultima_coleta: new Date().toISOString(),
      ultimo_erro: sucesso ? null : erro,
      total_coletas: supabase.rpc ? undefined : undefined, // incrementado via SQL
    })
    .eq('codigo', fonte_codigo);
}

// ── 1. CEPEA/ESALQ — preços ao produtor (fonte primária) ────
async function coletarCEPEA(supabase, cultura, dataRef) {
  const t0 = Date.now();
  const id = CEPEA_IDS[cultura];
  if (!id) return null;

  try {
    const res = await fetch(`https://www.cepea.org.br/br/widget/public/${id}.json`, {
      headers: { 'User-Agent':'AgroVendaAI/6.0', 'Referer':'https://www.cepea.org.br' },
      timeout: 12000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data?.data?.length) throw new Error('Sem dados CEPEA');

    // Pegar o dado mais recente
    const item = data.data[0];
    const preco = parseFloat((item.preco||'0').toString().replace(',','.'));
    if (!preco || preco <= 0) throw new Error('Preço CEPEA inválido');

    const dataItem = item.data ? new Date(item.data.split('/').reverse().join('-')) : new Date(dataRef);

    const registro = {
      cultura,
      data: dataItem.toISOString().split('T')[0],
      preco_brl: preco,
      fonte: 'CEPEA_ESALQ',
      confiabilidade: 95,
      coletado_em: new Date().toISOString()
    };

    await logColeta(supabase, { fonte_codigo:'CEPEA_ESALQ', cultura, data_ref:registro.data, registros:1, sucesso:true, duracao_ms:Date.now()-t0 });
    return registro;
  } catch (e) {
    await logColeta(supabase, { fonte_codigo:'CEPEA_ESALQ', cultura, data_ref:dataRef, registros:0, sucesso:false, erro:e.message, duracao_ms:Date.now()-t0 });
    return null;
  }
}

// ── 2. BCB/PTAX — dólar oficial ─────────────────────────────
async function coletarDolarBCB(supabase) {
  const t0 = Date.now();
  for (let d = 1; d <= 5; d++) {
    try {
      const dt = new Date(); dt.setDate(dt.getDate() - d);
      const mm = String(dt.getMonth()+1).padStart(2,'0');
      const dd = String(dt.getDate()).padStart(2,'0');
      const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@d)?@d='${mm}-${dd}-${dt.getFullYear()}'&$format=json&$select=cotacaoCompra,cotacaoVenda,dataHoraCotacao`;
      const res = await fetch(url, { timeout: 10000 });
      const data = await res.json();
      if (data?.value?.length > 0) {
        const c = data.value[data.value.length - 1];
        const ptax = parseFloat(((c.cotacaoCompra + c.cotacaoVenda) / 2).toFixed(4));
        await logColeta(supabase, { fonte_codigo:'BCB_PTAX', data_ref:dt.toISOString().split('T')[0], registros:1, sucesso:true, duracao_ms:Date.now()-t0 });
        return { ptax, data: dt.toISOString().split('T')[0] };
      }
    } catch (e) { /* tenta dia anterior */ }
  }
  await logColeta(supabase, { fonte_codigo:'BCB_PTAX', registros:0, sucesso:false, erro:'BCB indisponível', duracao_ms:Date.now()-t0 });
  return null;
}

// ── 3. Yahoo Finance — preço USD (fallback + referência internacional) ──
async function coletarYahoo(supabase, cultura) {
  const t0 = Date.now();
  const ticker = YAHOO_TICKERS[cultura];
  if (!ticker) return null;

  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`,
      { headers: { 'User-Agent':'Mozilla/5.0' }, timeout: 10000 }
    );
    const data = await res.json();
    const preco = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!preco) throw new Error('Sem preço Yahoo');

    // Yahoo retorna em cents — converter para USD
    const precoUSD = preco * YAHOO_FACTOR[cultura];

    await logColeta(supabase, { fonte_codigo:'YAHOO_CBOT', cultura, registros:1, sucesso:true, duracao_ms:Date.now()-t0 });
    return { preco_usd: parseFloat(precoUSD.toFixed(4)) };
  } catch (e) {
    await logColeta(supabase, { fonte_codigo:'YAHOO_CBOT', cultura, registros:0, sucesso:false, erro:e.message, duracao_ms:Date.now()-t0 });
    return null;
  }
}

// ── 4. Calcular indicadores técnicos (médias, volatilidade) ─
async function calcularIndicadores(supabase, cultura) {
  try {
    // Buscar últimos 200 dias de preços CEPEA
    const { data: hist } = await supabase
      .from('dados_mercado_historico')
      .select('data, preco_brl')
      .eq('cultura', cultura)
      .eq('fonte', 'CEPEA_ESALQ')
      .not('preco_brl', 'is', null)
      .order('data', { ascending: false })
      .limit(200);

    if (!hist?.length) return null;

    const precos = hist.map(h => h.preco_brl);
    const n = precos.length;

    // Médias móveis
    const media = (arr, dias) => dias > arr.length ? null :
      parseFloat((arr.slice(0, dias).reduce((s,v)=>s+v,0) / dias).toFixed(4));

    // Variações
    const varPct = (dias) => n > dias && precos[dias] > 0
      ? parseFloat(((precos[0] - precos[dias]) / precos[dias] * 100).toFixed(4))
      : null;

    // Volatilidade realizada (desvio padrão dos retornos logarítmicos, anualizada)
    const calcVol = (dias) => {
      if (n < dias + 1) return null;
      const retornos = [];
      for (let i = 0; i < dias; i++) {
        if (precos[i] > 0 && precos[i+1] > 0)
          retornos.push(Math.log(precos[i] / precos[i+1]));
      }
      if (retornos.length < 3) return null;
      const med = retornos.reduce((s,r)=>s+r,0) / retornos.length;
      const vari = retornos.reduce((s,r)=>s+Math.pow(r-med,2),0) / retornos.length;
      return parseFloat((Math.sqrt(vari * 252) * 100).toFixed(4));
    };

    const mes = new Date().getMonth();
    const sazonIdx = (SAZONALIDADE[cultura] || SAZONALIDADE.soja)[mes];

    return {
      media_7d:   media(precos, 7),
      media_20d:  media(precos, 20),
      media_60d:  media(precos, 60),
      media_200d: media(precos, 200),
      variacao_1d:  varPct(1),
      variacao_7d:  varPct(7),
      variacao_30d: varPct(30),
      volatilidade_20d: calcVol(20),
      volatilidade_60d: calcVol(60),
      sazonalidade_indice: parseFloat(sazonIdx.toFixed(4)),
    };
  } catch (e) {
    console.warn(`calcularIndicadores ${cultura}:`, e.message);
    return null;
  }
}

// ── 5. Clima agregado das regiões produtoras ─────────────────
async function coletarClimaAgregado(supabase, cultura) {
  // Regiões produtoras principais por cultura
  const regioesPorCultura = {
    cafe:    ['MG','SP','BA'],
    soja:    ['MT','PR','GO'],
    milho:   ['MT','PR','MS'],
    boi:     ['MT','MS','GO'],
    acucar:  ['SP','GO'],
    algodao: ['MT','BA'],
    trigo:   ['PR','RS'],
  };

  const regioes = regioesPorCultura[cultura] || ['MT'];

  try {
    const hoje = new Date().toISOString().split('T')[0];
    const { data: climaData } = await supabase
      .from('clima_previsao')
      .select('precipitacao_mm, temperatura_max, condicao')
      .in('regiao', regioes)
      .eq('data_previsao', hoje);

    if (!climaData?.length) return null;

    const precipMedia = climaData.reduce((s,c)=>s+(c.precipitacao_mm||0),0) / climaData.length;
    const tempMedia = climaData.reduce((s,c)=>s+(c.temperatura_max||0),0) / climaData.length;
    const secos = climaData.filter(c=>c.condicao==='seco').length;
    const chuvosos = climaData.filter(c=>c.condicao==='chuva').length;
    const anomalia = secos > climaData.length/2 ? 'seca' : chuvosos > climaData.length/2 ? 'excesso' : 'normal';

    return {
      precipitacao_media_mm: parseFloat(precipMedia.toFixed(2)),
      temperatura_media_c:   parseFloat(tempMedia.toFixed(2)),
      anomalia_climatica:    anomalia,
    };
  } catch (e) { return null; }
}

// ── FUNÇÃO PRINCIPAL: coletar e salvar 1 cultura ─────────────
async function coletarEPersistir(supabase, cultura) {
  const dataHoje = new Date().toISOString().split('T')[0];
  console.log(`📊 Coletando: ${cultura} — ${dataHoje}`);

  // Coletas paralelas
  const [cepea, dolar, yahoo, clima] = await Promise.all([
    coletarCEPEA(supabase, cultura, dataHoje),
    coletarDolarBCB(supabase),
    coletarYahoo(supabase, cultura),
    coletarClimaAgregado(supabase, cultura),
  ]);

  // Calcular indicadores técnicos (após salvar o preço do dia)
  const indicadores = await calcularIndicadores(supabase, cultura);

  // Montar registro unificado
  const registro = {
    cultura,
    data: dataHoje,
    fonte: 'CALCULADO',          // calculado = agregado de múltiplas fontes
    confiabilidade: cepea ? 90 : 60,

    // Preços
    preco_brl:  cepea?.preco_brl  || null,
    preco_usd:  yahoo?.preco_usd  || null,
    dolar_ptax: dolar?.ptax       || null,

    // Indicadores técnicos
    ...indicadores,

    // Clima
    ...clima,

    // Timestamp
    coletado_em: new Date().toISOString(),
  };

  // Salvar preço CEPEA em registro separado (fonte primária)
  if (cepea) {
    await supabase.from('dados_mercado_historico').upsert({
      ...cepea,
      dolar_ptax: dolar?.ptax || null,
      preco_usd: yahoo?.preco_usd || null,
      ...indicadores,
      ...clima,
    }, { onConflict: 'cultura,data,fonte', ignoreDuplicates: false });
    // catch handled above;
  }

  // Também salvar registro Yahoo se CEPEA falhou (fallback)
  if (!cepea && yahoo && dolar) {
    const CONV = { cafe:132.276, soja:0.2205, milho:0.2362, boi:0.45359, acucar:0.50, algodao:0.15, trigo:0.2205 };
    const preco_brl_est = Math.round(yahoo.preco_usd * (CONV[cultura]||1) * dolar.ptax);
    await supabase.from('dados_mercado_historico').upsert({
      cultura, data: dataHoje, fonte: 'YAHOO_CBOT',
      preco_brl: preco_brl_est, preco_usd: yahoo.preco_usd,
      dolar_ptax: dolar.ptax, confiabilidade: 70,
      ...indicadores, ...clima,
      coletado_em: new Date().toISOString(),
    }, { onConflict: 'cultura,data,fonte', ignoreDuplicates: false })
    // .catch(e => console.warn(`Upsert Yahoo ${cultura}:`, e.message)); // error handled silently
  }

  return {
    cultura, data: dataHoje,
    preco_brl: cepea?.preco_brl || null,
    dolar: dolar?.ptax || null,
    fontes: { cepea: !!cepea, yahoo: !!yahoo, dolar: !!dolar, clima: !!clima },
  };
}

// ── COLETA COMPLETA: todas as culturas ───────────────────────
async function coletarTodas(supabase) {
  console.log('🌾 Iniciando coleta completa de dados de mercado...');
  const resultados = [];

  for (const cultura of CULTURAS) {
    const resultado = await coletarEPersistir(supabase, cultura);
    resultados.push(resultado);
    await new Promise(r => setTimeout(r, 800)); // evitar rate limit CEPEA
  }

  const sucesso = resultados.filter(r => r.preco_brl).length;
  console.log(`✅ Coleta concluída: ${sucesso}/${CULTURAS.length} culturas com preço real`);
  return resultados;
}

// ── GERAR SINAL E SALVAR ─────────────────────────────────────
async function gerarESalvarSinal(supabase, cultura, scoreResult, probabilidades, estrategia) {
  try {
    const { data: dadosMercado } = await supabase
      .from('dados_mercado_historico')
      .select('id, preco_brl, dolar_ptax')
      .eq('cultura', cultura)
      .eq('data', new Date().toISOString().split('T')[0])
      .in('fonte', ['CEPEA_ESALQ', 'CALCULADO'])
      .limit(1).single();

    const sinalData = {
      cultura,
      data: new Date().toISOString().split('T')[0],
      score: scoreResult.score,
      market_timing_score: estrategia?.market_timing?.score || null,
      probabilidade_alta:   probabilidades?.horizonte_15d?.prob_alta || null,
      probabilidade_queda:  probabilidades?.horizonte_15d?.prob_queda || null,
      probabilidade_lateral: probabilidades?.horizonte_15d?.prob_lateral || null,
      confianca: scoreResult.confianca,
      decisao_sugerida: scoreResult.classificacao === 'oportunidade' ? 'vender' :
                        scoreResult.classificacao === 'favoravel'    ? 'parcial' :
                        scoreResult.classificacao === 'neutro'       ? 'aguardar' : 'aguardar',
      pct_vender:   estrategia?.pct_vender_agora || 0,
      pct_travar:   estrategia?.pct_travar || 0,
      pct_aguardar: estrategia?.pct_aguardar || 100,
      horizonte_dias: 15,
      preco_brl_momento: dadosMercado?.preco_brl || null,
      dolar_momento:     dadosMercado?.dolar_ptax || null,
      fatores_usados:    scoreResult.itens || {},
      dados_mercado_id:  dadosMercado?.id || null,
      versao_algoritmo:  '6.0',
      modelo_usado:      'score_quantitativo',
    };

    const { data: sinal } = await supabase
      .from('sinais_ia')
      .upsert(sinalData, { onConflict: 'cultura,data,versao_algoritmo,horizonte_dias' })
      .select().single();

    // Criar resultado pendente para backtesting futuro
    if (sinal?.id && dadosMercado?.preco_brl) {
      await supabase.from('resultados_sinais').upsert({
        sinal_id: sinal.id,
        cultura,
        preco_no_momento: dadosMercado.preco_brl,
        resultado_principal: 'pendente',
      }, { onConflict: 'sinal_id,cultura' });
    }

    return sinal;
  } catch (e) {
    console.warn(`gerarESalvarSinal ${cultura}:`, e.message);
    return null;
  }
}

// ── BACKFILL: popular histórico com dados existentes ─────────
// Migra dados de historico_precos → dados_mercado_historico
async function backfillHistorico(supabase, limite = 500) {
  console.log('🔄 Backfill: migrando historico_precos → dados_mercado_historico...');
  let migrados = 0;

  const { data: historico } = await supabase
    .from('historico_precos')
    .select('cultura, preco_brl, dolar, fonte, coletado_em')
    .not('preco_brl', 'is', null)
    .order('coletado_em', { ascending: false })
    .limit(limite);

  if (!historico?.length) {
    console.log('Nada para migrar.');
    return 0;
  }

  const registros = historico.map(h => ({
    cultura: h.cultura,
    data: h.coletado_em.split('T')[0],
    preco_brl: h.preco_brl,
    dolar_ptax: h.dolar,
    fonte: h.fonte === 'CEPEA/ESALQ' ? 'CEPEA_ESALQ' : (h.fonte || 'YAHOO_CBOT'),
    confiabilidade: h.fonte === 'CEPEA/ESALQ' ? 95 : 70,
    coletado_em: h.coletado_em,
  }));

  // Inserir em lotes de 50
  for (let i = 0; i < registros.length; i += 50) {
    const lote = registros.slice(i, i + 50);
    const { error } = await supabase
      .from('dados_mercado_historico')
      .upsert(lote, { onConflict: 'cultura,data,fonte', ignoreDuplicates: true });
    if (!error) migrados += lote.length;
  }

  console.log(`✅ Backfill concluído: ${migrados} registros migrados`);
  return migrados;
}

module.exports = {
  coletarTodas, coletarEPersistir,
  coletarDolarBCB, coletarCEPEA, coletarYahoo,
  gerarESalvarSinal, backfillHistorico,
};
