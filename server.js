// src/server.js — AgroVenda Pro AI v6.0
// Infraestrutura de dados real + rotas de ML + backtesting
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const { buscarTodosPrecos } = require('./precos');
const { calcularScore, gerarContextoParaIA, VERSAO } = require('./score');
const { calcularTodosHorizontes, calcularProbabilidadeComML } = require('./probabilidade');
const { gerarEstrategia, calcularMarketTimingScore } = require('./estrategia');
const { gerarCurvaVenda, recomendarTravamento } = require('./safra');
const { iniciarAutomacao, cicloPrincipal, avaliarBacktesting } = require('./automacao');
const { enviarTelegram, enfileirar } = require('./fila');
const { autenticar, verificarLimiteIA, registrarUsoIA, getBotToken } = require('./auth');
const { log, EVENTOS, getIP } = require('./logs');
const { processarMercadoPago, processarAsaas, processarStripe, criarLinkMP } = require('./pagamento');
const { gerarOportunidades, buscarOportunidadesAtivas } = require('./radar');
const { simular } = require('./simulacao');
const { processarMensagem: processarWhatsApp } = require('./whatsapp');
const { gerarBriefingProdutor, analisarCultura, etapa_buscarDados } = require('./agente');
const { buscarMemoria, gerarContextoIA, atualizarMemoria, salvarMeta, atualizarVolumeMeta } = require('./memoria');
const { calcularOnboarding, criarTicket, assistenteSuporteIA, registrarFeedback, listarArtigos, buscarArtigo, CATEGORIAS } = require('./suporte');
const { MOTIVOS_DECISAO, motivoAfetaModelo, calcularPerfilDecisao, explicarRecomendacao, buscarJornada } = require('./explicacao');
const {
  DISCLAIMER, moderarLinguagem, verificarLinguagem, gerarAnaliseRiscos,
  registrarConsentimento, verificarConsentimentos,
  logarRecomendacao, registrarAceiteDisclaimer, registrarAcaoUsuario,
  exportarDadosUsuario, solicitarExclusaoConta,
  confirmarDecisaoComercial, TEXTO_CONFIRMACAO_DECISAO
} = require('./compliance');
const { coletarTodas, backfillHistorico } = require('./coleta');
const {
  dashboardValidacao, resumoUltimosN, historicoPaginado,
  validacaoPorScore, validacaoMensal, calibracao, detalhesSinal
} = require('./validacao');

['ANTHROPIC_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_KEY','SUPABASE_ANON_KEY','ADMIN_SECRET']
  .filter(v=>!process.env[v]).forEach(v=>{console.error('Faltando: '+v);process.exit(1);});

const app = express();
app.set('trust proxy', 1);

const limGlobal = rateLimit({windowMs:60000,max:300,message:{erro:'Muitas requisições.'}});
const limLogin  = rateLimit({windowMs:900000,max:10,message:{erro:'Muitas tentativas.'}});
const limIA     = rateLimit({windowMs:3600000,max:40,message:{erro:'Limite análises/hora.'}});
const limChat   = rateLimit({windowMs:60000,max:15,message:{erro:'Limite chat/min.'}});
const limAgente = rateLimit({windowMs:3600000,max:5,message:{erro:'Limite briefings/hora.'}});

app.use(express.json({limit:'50kb'}));
const origens = [process.env.FRONTEND_URL,'http://localhost:3001','http://localhost:5173'].filter(Boolean);
app.use(cors({
  origin:(o,cb)=>(!o||origens.includes(o))?cb(null,true):cb(new Error('Origem não permitida')),
  credentials:true
}));
app.use(limGlobal);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
app.locals.supabase = supabase;

const CULTURAS_VALIDAS = new Set(['cafe','soja','milho','boi','acucar','algodao','trigo']);
const validarCultura = (req,res,next) => {
  const c = req.params.cultura || req.body?.cultura;
  if (c && !CULTURAS_VALIDAS.has(c)) return res.status(400).json({erro:'Cultura inválida.'});
  next();
};
async function verOwnership(t,id,pid) {
  const {data}=await supabase.from(t).select('id').eq('id',id).eq('perfil_id',pid).single();
  return !!data;
}
async function temRecurso(pid,r) {
  const {data}=await supabase.rpc('tem_recurso',{p_perfil_id:pid,p_recurso:r});
  return !!data;
}
async function exigirAdmin(req,res,next) {
  if (req.headers['x-admin-secret']===process.env.ADMIN_SECRET) return next();
  if (req.perfil?.cargo==='admin') return next();
  return res.status(403).json({erro:'Acesso restrito.'});
}

// FIX: verificação de consent movida para auth.js middleware autenticar()

async function buscarCtx(perfil_id, cultura) {
  const [{data:pp},climaRow,histRow] = await Promise.all([
    supabase.from('produtor_perfil').select('*').eq('perfil_id',perfil_id).single(),
    supabase.from('clima_previsao').select('impacto_preco').eq('cultura',cultura)
      .gte('data_previsao',new Date().toISOString().split('T')[0]).order('data_previsao').limit(7),
    supabase.from('dados_mercado_historico').select('preco_brl')
      .eq('cultura',cultura).in('fonte',['CEPEA_ESALQ','YAHOO_CBOT'])
      .order('data',{ascending:false}).limit(60)
  ]);
  const climaImpactos=climaRow.data||[];
  const pos=climaImpactos.filter(c=>c.impacto_preco==='positivo').length;
  const neg=climaImpactos.filter(c=>c.impacto_preco==='negativo').length;
  return {
    pp,culturaData:pp?.culturas?.[cultura]||{},
    custoProd:pp?.culturas?.[cultura]?.custo_saca||null,
    sacasEstoque:pp?.culturas?.[cultura]?.estoque_atual||null,
    dividaAtiva:pp?.divida_ativa||false,
    precisaCaixa:pp?.precisa_caixa||false,
    objetivoProd:pp?.objetivo||'maximizar_preco',
    perfilRisco:pp?.perfil_risco||'moderado',
    climaImpacto:pos>neg?'positivo':neg>pos?'negativo':'neutro',
    historicoPrecos:(histRow.data||[]).map(h=>h.preco_brl).filter(Boolean)
  };
}

// ══════════ AUTH ══════════════════════════════════════════════
app.post('/auth/login', limLogin, async (req,res) => {
  const {email,senha}=req.body;
  if (!email||!senha) return res.status(400).json({erro:'E-mail e senha obrigatórios.'});
  const cli=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY);
  const {data,error}=await cli.auth.signInWithPassword({email,password:senha});
  if (error) {
    await log(supabase,{evento:EVENTOS.LOGIN_FALHOU,nivel:'aviso',detalhe:{email},ip:getIP(req)});
    return res.status(401).json({erro:'E-mail ou senha incorretos.'});
  }
  const {data:perfil}=await supabase.from('perfis')
    .select('nome,plano,ativo,cargo,telegram_chat_id').eq('id',data.user.id).single();
  if (!perfil?.ativo) return res.status(403).json({erro:'Conta suspensa.'});
  await log(supabase,{perfil_id:data.user.id,evento:EVENTOS.LOGIN,nivel:'info',ip:getIP(req)});
  res.json({ok:true,access_token:data.session.access_token,
    refresh_token:data.session.refresh_token,expira_em:data.session.expires_at,
    usuario:{nome:perfil.nome,plano:perfil.plano,cargo:perfil.cargo,telegram:!!perfil.telegram_chat_id}});
});
app.post('/auth/renovar', async (req,res) => {
  const cli=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY);
  const {data,error}=await cli.auth.refreshSession({refresh_token:req.body.refresh_token});
  if (error) return res.status(401).json({erro:'Token expirado.'});
  res.json({ok:true,access_token:data.session.access_token,expira_em:data.session.expires_at});
});
app.post('/auth/logout', autenticar, async (req,res) => {
  try { const cli=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY);
    await cli.auth.admin.signOut((req.headers.authorization||'').slice(7)).catch(()=>{}); } catch(e){}
  await log(supabase,{perfil_id:req.perfil.id,evento:EVENTOS.LOGOUT,nivel:'info',ip:getIP(req)});
  res.json({ok:true});
});

// ══════════ PERFIL ════════════════════════════════════════════
app.get('/perfil', autenticar, (req,res) => {
  const p=req.perfil;
  res.json({ok:true,nome:p.nome,plano:p.plano,validade:p.validade,
    cargo:p.cargo,culturas:p.culturas_interesse,telegram_configurado:!!p.telegram_chat_id,limite:req.limite});
});
app.put('/perfil', autenticar, async (req,res) => {
  const {nome,telefone,culturas_interesse,estado,municipio}=req.body;
  const cv=Array.isArray(culturas_interesse)?culturas_interesse.filter(c=>CULTURAS_VALIDAS.has(c)).slice(0,8):undefined;
  await supabase.from('perfis').update({nome,telefone,estado,municipio,
    ...(cv!==undefined?{culturas_interesse:cv}:{}),atualizado_em:new Date().toISOString()}).eq('id',req.perfil.id);
  res.json({ok:true});
});
app.get('/perfil/produtor', autenticar, async (req,res) => {
  const {data}=await supabase.from('produtor_perfil').select('*').eq('perfil_id',req.perfil.id).single();
  res.json({ok:true,perfil:data||null});
});
app.put('/perfil/produtor', autenticar, async (req,res) => {
  const {area_total_ha,municipio,estado,culturas,objetivo,perfil_risco,divida_ativa,precisa_caixa,canal_alerta,horario_alerta}=req.body;
  const {data,error}=await supabase.from('produtor_perfil').upsert({
    perfil_id:req.perfil.id,area_total_ha,municipio,estado,culturas,objetivo,
    perfil_risco,divida_ativa,precisa_caixa,canal_alerta,horario_alerta,
    atualizado_em:new Date().toISOString()},{onConflict:'perfil_id'}).select().single();
  if (error) return res.status(500).json({erro:error.message});

  // FIX R5: avisar sobre limitações para contratos fixos
  const avisos = [];
  if (req.body.canal_venda === 'contrato_fixo') {
    avisos.push('Com venda por contrato fixo (cooperativa/usina), use o AgroVenda para definir '
      + 'o timing de renovação e fixação antecipada — não para venda spot.');
  }
  if (req.body.culturas) {
    const temCustoDefinido = Object.values(req.body.culturas).some(c => c.custo_saca);
    if (!temCustoDefinido) avisos.push('Configure o custo de produção por saca para análises mais precisas.');
  }

  res.json({ok:true, perfil:data, avisos:avisos.length ? avisos : undefined});
});

// ══════════ CENTRAL DE DECISÃO ════════════════════════════════
app.get('/central', autenticar, async (req,res) => {
  try {
    const [precos,centralRow,oportunidades,ultimasDecisoes,relatorio,sinaisRecentes] = await Promise.all([
      buscarTodosPrecos(supabase),
      supabase.from('central_decisao').select('*').eq('perfil_id',req.perfil.id).single(),
      buscarOportunidadesAtivas(supabase,req.perfil.culturas_interesse,5),
      supabase.from('decisoes').select('cultura,decisao,score_no_momento,preco_executado,resultado,data_decisao')
        .eq('perfil_id',req.perfil.id).order('criado_em',{ascending:false}).limit(5),
      supabase.from('relatorios_agente').select('conteudo,decisoes_sugeridas,criado_em')
        .eq('perfil_id',req.perfil.id).order('criado_em',{ascending:false}).limit(1),
      supabase.from('sinais_ia').select('cultura,score,market_timing_score,probabilidade_alta,probabilidade_queda,decisao_sugerida,data')
        .in('cultura',req.perfil.culturas_interesse||['cafe','soja','milho','boi'])
        .order('data',{ascending:false}).limit(12)
    ]);

    // MTS por cultura
    const mtsAtual = {};
    for (const cultura of (req.perfil.culturas_interesse||['cafe','soja']).slice(0,4)) {
      const p = precos.precos[cultura];
      if (!p?.brl) continue;
      const ctx = await buscarCtx(req.perfil.id, cultura);
      const score = calcularScore({
        cultura,precoAtual:p.brl,precoMedia60d:p.media60d,preco7dAtras:p.preco7dAtras,
        dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
        estoqueStatus:'neutro',volatilidadeAlta:false,...ctx
      });
      const probs = calcularTodosHorizontes({
        cultura,precoAtual:p.brl,precoMedia60d:p.media60d,preco7dAtras:p.preco7dAtras,
        dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
        historicoPrecos:ctx.historicoPrecos,estoqueStatus:'neutro',climaImpacto:ctx.climaImpacto
      });
      const mts = calcularMarketTimingScore(score.score,probs);
      mtsAtual[cultura] = {
        score:score.score,mts:mts.score,classificacao:mts.classificacao,
        emoji:mts.emoji,acao:mts.descricao,
        prob_alta_15d:probs.horizonte_15d.prob_alta,preco:p.brl
      };
    }

    // FIX R3: ranking consolidado de culturas por MTS (para policultores)
    const culturasPorMTS = Object.entries(mtsAtual)
      .sort(([,a],[,b]) => b.mts - a.mts)
      .map(([cultura,dados],idx) => ({
        posicao: idx+1, cultura, ...dados,
        recomendacao_curta:
          dados.mts >= 70 ? `${idx===0?'Prioridade':'Favorável'} para vender` :
          dados.mts >= 50 ? 'Aguardar' : 'Evitar venda'
      }));

    res.json({
      ok:true,dolar:precos.dolar,timestamp:precos.timestamp,
      market_timing:mtsAtual,
      ranking_culturas:culturasPorMTS,  // NOVO: qual cultura vender primeiro
      sinais_recentes:(sinaisRecentes.data||[]),
      resumo_central:centralRow.data,
      oportunidades_ativas:oportunidades,
      ultimas_decisoes:ultimasDecisoes.data||[],
      ultimo_relatorio:relatorio.data?.[0]||null,
      horario:new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})
    });
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// ══════════ DADOS DE MERCADO (v6) ═════════════════════════════
// Série histórica real para análise e ML
app.get('/dados/historico/:cultura', autenticar, validarCultura, async (req,res) => {
  const dias = Math.min(parseInt(req.query.dias)||90, 365);
  const fonte = req.query.fonte || 'CEPEA_ESALQ';
  const dataInicio = new Date(); dataInicio.setDate(dataInicio.getDate()-dias);

  const {data} = await supabase
    .from('dados_mercado_historico')
    .select('data,preco_brl,preco_usd,dolar_ptax,variacao_1d,variacao_7d,variacao_30d,media_7d,media_20d,media_60d,volatilidade_20d,volatilidade_60d,sazonalidade_indice,precipitacao_media_mm,anomalia_climatica,confiabilidade,fonte')
    .eq('cultura',req.params.cultura)
    .eq('fonte',fonte)
    .gte('data',dataInicio.toISOString().split('T')[0])
    .order('data',{ascending:true});

  res.json({ok:true,cultura:req.params.cultura,fonte,registros:data?.length||0,dados:data||[]});
});

// Último dado de mercado por cultura
app.get('/dados/ultimo/:cultura', autenticar, validarCultura, async (req,res) => {
  const {data} = await supabase
    .from('dados_mercado_historico')
    .select('*')
    .eq('cultura',req.params.cultura)
    .in('fonte',['CEPEA_ESALQ','CALCULADO'])
    .order('data',{ascending:false}).limit(1).single();
  res.json({ok:true,dado:data||null});
});

// Qualidade dos dados (monitoramento)
app.get('/dados/qualidade', autenticar, async (req,res) => {
  const {data} = await supabase.from('qualidade_dados').select('*');
  res.json({ok:true,fontes:data||[]});
});

// ══════════ SINAIS IA (v6) ════════════════════════════════════
// Histórico de sinais gerados pelo motor
app.get('/sinais/:cultura', autenticar, validarCultura, async (req,res) => {
  const dias = Math.min(parseInt(req.query.dias)||30, 90);
  const dataInicio = new Date(); dataInicio.setDate(dataInicio.getDate()-dias);

  const {data} = await supabase
    .from('sinais_ia')
    .select('data,score,market_timing_score,probabilidade_alta,probabilidade_queda,confianca,decisao_sugerida,pct_vender,pct_travar,pct_aguardar,preco_brl_momento,dolar_momento,versao_algoritmo')
    .eq('cultura',req.params.cultura)
    .gte('data',dataInicio.toISOString().split('T')[0])
    .order('data',{ascending:false});

  res.json({ok:true,cultura:req.params.cultura,sinais:data||[]});
});

// Sinal mais recente por cultura
app.get('/sinais/:cultura/ultimo', autenticar, validarCultura, async (req,res) => {
  const {data} = await supabase
    .from('sinais_ia')
    .select('*')
    .eq('cultura',req.params.cultura)
    .order('data',{ascending:false}).limit(1).single();
  res.json({ok:true,sinal:data||null});
});

// ══════════ BACKTESTING E ACCURACY ═══════════════════════════
app.get('/backtesting/:cultura', autenticar, validarCultura, async (req,res) => {
  const {data:resultados} = await supabase
    .from('resultados_sinais')
    .select('*, sinais_ia(data,score,decisao_sugerida,probabilidade_alta)')
    .eq('cultura',req.params.cultura)
    .neq('resultado_principal','pendente')
    .order('criado_em',{ascending:false})
    .limit(60);

  const {data:accuracy} = await supabase
    .from('accuracy_sinais')
    .select('*')
    .eq('cultura',req.params.cultura)
    .single();

  res.json({ok:true,cultura:req.params.cultura,accuracy:accuracy||null,resultados:resultados||[]});
});

app.get('/backtesting/resumo/geral', autenticar, async (req,res) => {
  const {data} = await supabase.from('accuracy_sinais').select('*').order('accuracy_15d_pct',{ascending:false});
  res.json({ok:true,resumo:data||[]});
});

// ══════════ PREÇOS ════════════════════════════════════════════
app.get('/precos', autenticar, async (req,res) => {
  try { res.json({ok:true,...await buscarTodosPrecos(supabase)}); }
  catch(e) { res.status(500).json({ok:false,erro:e.message}); }
});
app.get('/precos/historico/:cultura', autenticar, validarCultura, async (req,res) => {
  const dias=Math.min(parseInt(req.query.dias)||60,180);
  const {data}=await supabase.from('dados_mercado_historico')
    .select('data,preco_brl,dolar_ptax').eq('cultura',req.params.cultura)
    .eq('fonte','CEPEA_ESALQ').order('data',{ascending:false}).limit(dias);
  res.json({ok:true,historico:data||[]});
});

// ══════════ SCORE + ESTRATÉGIA + PROBABILIDADE ═══════════════
app.post('/score', autenticar, validarCultura, async (req,res) => {
  const {cultura,custo_saca,estoque,volatil}=req.body;
  if (!cultura||!CULTURAS_VALIDAS.has(cultura)) return res.status(400).json({erro:'Cultura inválida.'});
  const [precos,ctx]=await Promise.all([buscarTodosPrecos(supabase),buscarCtx(req.perfil.id,cultura)]);
  const p=precos.precos[cultura];
  if (!p?.brl) return res.status(422).json({erro:'Preço indisponível.'});
  const score=calcularScore({
    cultura,precoAtual:p.brl,precoMedia60d:p.media60d,preco7dAtras:p.preco7dAtras,
    dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
    custoProd:custo_saca||ctx.custoProd,estoqueStatus:estoque||'neutro',
    volatilidadeAlta:volatil||false,climaImpacto:ctx.climaImpacto,...ctx
  });
  const probs=await calcularProbabilidadeComML({
    cultura,precoAtual:p.brl,precoMedia60d:p.media60d,preco7dAtras:p.preco7dAtras,
    dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
    historicoPrecos:ctx.historicoPrecos,estoqueStatus:estoque||'neutro',climaImpacto:ctx.climaImpacto
  });
  const mts=calcularMarketTimingScore(score.score,probs);
  await supabase.from('tabela_scores').insert({
    perfil_id:req.perfil.id,cultura,score:score.score,fatores:score.itens,
    recomendacao:score.acao,preco_na_analise:p.brl,dolar_na_analise:precos.dolar,versao_algoritmo:'6.0'
  }).catch(()=>{});
  res.json({ok:true,...score,market_timing:mts,probabilidades:probs,precoAtual:p.brl,dolar:precos.dolar,fonte:p.fonte});
});

app.post('/estrategia', autenticar, validarCultura, async (req,res) => {
  if(!(await temRecurso(req.perfil.id,'estrategia')))
    return res.status(403).json({erro:'Estratégia disponível a partir do plano Básico.'});
  const {cultura,custo_saca,sacas_estoque}=req.body;
  if (!cultura) return res.status(400).json({erro:'Cultura obrigatória.'});
  const [precos,ctx]=await Promise.all([buscarTodosPrecos(supabase),buscarCtx(req.perfil.id,cultura)]);
  const p=precos.precos[cultura];
  if (!p?.brl) return res.status(422).json({erro:'Preço indisponível.'});
  const score=calcularScore({
    cultura,precoAtual:p.brl,precoMedia60d:p.media60d,preco7dAtras:p.preco7dAtras,
    dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
    custoProd:custo_saca||ctx.custoProd,estoqueStatus:'neutro',
    volatilidadeAlta:false,climaImpacto:ctx.climaImpacto,...ctx
  });
  const probs=await calcularProbabilidadeComML({
    cultura,precoAtual:p.brl,precoMedia60d:p.media60d,preco7dAtras:p.preco7dAtras,
    dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
    historicoPrecos:ctx.historicoPrecos,estoqueStatus:'neutro',climaImpacto:ctx.climaImpacto
  });
  const estrategia=gerarEstrategia({
    cultura,score9var:score.score,probabilidades:probs,
    objetivo:ctx.objetivoProd,perfilRisco:ctx.perfilRisco,
    dividaAtiva:ctx.dividaAtiva,precisaCaixa:ctx.precisaCaixa,
    sacasEstoque:sacas_estoque||ctx.sacasEstoque,custoProd:custo_saca||ctx.custoProd,
    precoAtual:p.brl,dolar:precos.dolar,climaImpacto:ctx.climaImpacto,estoqueStatus:'neutro'
  });
  await supabase.from('estrategias_venda').insert({
    perfil_id:req.perfil.id,cultura,
    pct_vender_agora:estrategia.pct_vender_agora,pct_travar:estrategia.pct_travar,
    pct_aguardar:estrategia.pct_aguardar,motivo_principal:estrategia.motivo_principal,
    riscos:estrategia.riscos,oportunidades:estrategia.oportunidades,
    market_timing_score:estrategia.market_timing.score,confianca:estrategia.confianca,
    validade:new Date(Date.now()+24*3600*1000).toISOString()
  }).catch(()=>{});
  res.json({ok:true,...estrategia,probabilidades:probs,score_9var:score.score,preco_atual:p.brl});
});

app.post('/probabilidade', autenticar, validarCultura, async (req,res) => {
  if(!(await temRecurso(req.perfil.id,'probabilidade')))
    return res.status(403).json({erro:'Probabilidade disponível a partir do plano Básico.'});
  const {cultura}=req.body;
  const [precos,ctx]=await Promise.all([buscarTodosPrecos(supabase),buscarCtx(req.perfil.id,cultura)]);
  const p=precos.precos[cultura];
  if (!p?.brl) return res.status(422).json({erro:'Preço indisponível.'});
  const probs=await calcularProbabilidadeComML({
    cultura,precoAtual:p.brl,precoMedia60d:p.media60d,preco7dAtras:p.preco7dAtras,
    dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
    historicoPrecos:ctx.historicoPrecos,estoqueStatus:'neutro',climaImpacto:ctx.climaImpacto
  });
  res.json({ok:true,cultura,preco_atual:p.brl,dolar:precos.dolar,...probs});
});

// ══════════ SAFRA ═════════════════════════════════════════════
app.post('/safra/curva', autenticar, validarCultura, async (req,res) => {
  if(!(await temRecurso(req.perfil.id,'safra_planning')))
    return res.status(403).json({erro:'Planejamento de safra nos planos Pro e Premium.'});
  const {cultura,safra,producao_prevista_sc,custo_saca,preco_meta}=req.body;
  if (!cultura||!safra) return res.status(400).json({erro:'cultura e safra obrigatórios.'});
  const [precos,ctx]=await Promise.all([buscarTodosPrecos(supabase),buscarCtx(req.perfil.id,cultura)]);
  const curva=gerarCurvaVenda({
    cultura,safra,
    producao_prevista_sc:producao_prevista_sc||ctx.culturaData?.producao_prevista_sc,
    custo_saca:custo_saca||ctx.custoProd,
    preco_atual:precos.precos[cultura]?.brl,dolar:precos.dolar,
    preco_meta,perfil_risco:ctx.perfilRisco,objetivo:ctx.objetivoProd,dividaAtiva:ctx.dividaAtiva
  });
  await supabase.from('planejamento_safra').upsert({
    perfil_id:req.perfil.id,cultura,safra,
    producao_prevista_sc:curva.producao_prevista_sc,
    custo_saca:curva.custo_saca,preco_meta,curva_venda:curva.curva,
    atualizado_em:new Date().toISOString()
  },{onConflict:'perfil_id,cultura,safra'}).catch(()=>{});
  res.json({ok:true,...curva});
});

app.post('/safra/travamento', autenticar, validarCultura, async (req,res) => {
  if(!(await temRecurso(req.perfil.id,'safra_planning')))
    return res.status(403).json({erro:'Análise de travamento nos planos Pro e Premium.'});
  const {cultura,producao_prevista_sc,custo_saca}=req.body;
  const [precos,ctx]=await Promise.all([buscarTodosPrecos(supabase),buscarCtx(req.perfil.id,cultura)]);
  const p=precos.precos[cultura];
  const probs=await calcularProbabilidadeComML({
    cultura,precoAtual:p?.brl,precoMedia60d:p?.media60d,preco7dAtras:p?.preco7dAtras,
    dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
    historicoPrecos:ctx.historicoPrecos,estoqueStatus:'neutro',climaImpacto:ctx.climaImpacto
  });
  const rec=recomendarTravamento({
    cultura,producao_prevista_sc:producao_prevista_sc||ctx.culturaData?.producao_prevista_sc,
    preco_atual:p?.brl,custo_saca:custo_saca||ctx.custoProd,
    prob_queda_30d:probs.horizonte_30d.prob_queda,
    perfilRisco:ctx.perfilRisco,dividaAtiva:ctx.dividaAtiva
  });
  res.json({ok:true,...rec,probabilidades:probs,preco_atual:p?.brl,dolar:precos.dolar});
});

app.get('/safra/planejamento', autenticar, async (req,res) => {
  const {data}=await supabase.from('planejamento_safra').select('*')
    .eq('perfil_id',req.perfil.id).order('criado_em',{ascending:false});
  res.json({ok:true,planejamentos:data||[]});
});

// ══════════ AI AGENT ══════════════════════════════════════════
// Análise pontual de 1 cultura — pipeline completo em tempo real
app.post('/agente/analisar/:cultura', autenticar, limIA, validarCultura, async (req,res) => {
  if (!(await temRecurso(req.perfil.id,'agente_ia')))
    return res.status(403).json({erro:'AI Agent disponível nos planos Pro e Premium.'});

  const { cultura } = req.params;
  try {
    // Buscar perfil do produtor
    const { data: ppData } = await supabase.from('produtor_perfil')
      .select('*').eq('perfil_id', req.perfil.id).single();

    // Buscar token Telegram pontualmente
    const { data: tokData } = await supabase.from('perfis')
      .select('telegram_bot_token,telegram_chat_id,telefone,plano')
      .eq('id', req.perfil.id).single();

    const perfilCompleto = {
      ...req.perfil,
      telegram_bot_token: tokData?.telegram_bot_token,
      telegram_chat_id:   tokData?.telegram_chat_id,
      telefone:           tokData?.telefone,
      plano:              tokData?.plano,
    };

    const enviarTelegram = req.body.enviar_telegram !== false;
    if (!enviarTelegram) {
      // Sem envio: apenas retornar os dados
      perfilCompleto.telegram_bot_token = null;
    }

    const resultado = await analisarCultura(
      supabase, perfilCompleto, ppData, cultura, process.env.ANTHROPIC_API_KEY
    );

    if (!resultado) {
      return res.status(422).json({
        erro: 'Dados de mercado indisponíveis para esta cultura.',
        cultura,
        sugestao: 'Execute uma coleta manual: POST /admin/coleta/executar'
      });
    }

    res.json({ ok: true, ...resultado });
  } catch(e) {
    res.status(500).json({erro: e.message});
  }
});

app.post('/agente/briefing', autenticar, limAgente, async (req,res) => {
  if(!(await temRecurso(req.perfil.id,'agente_ia')))
    return res.status(403).json({erro:'AI Agent disponível nos planos Pro e Premium.'});
  try {
    const precos=await buscarTodosPrecos(supabase);
    const briefing=await gerarBriefingProdutor(supabase,req.perfil,precos,process.env.ANTHROPIC_API_KEY);
    if (req.body.enviar_telegram!==false) {
      const {telegram_bot_token,telegram_chat_id}=await getBotToken(supabase,req.perfil.id);
      if (telegram_bot_token&&telegram_chat_id) {
        await enfileirar(supabase,{
          perfil_id:req.perfil.id,tipo:'agente_manual',mensagem:briefing.msgTelegram,
          destino_bot:telegram_bot_token,destino_chat:telegram_chat_id
        });
      }
    }
    res.json({ok:true,briefing:briefing.textoBriefing,
      analises:briefing.analises.map(a=>({
        cultura:a.cultura,score:a.score.score,mts:a.estrategia.market_timing.score,
        estrategia:{vender:a.estrategia.pct_vender_agora,travar:a.estrategia.pct_travar,
          aguardar:a.estrategia.pct_aguardar,resumo:a.estrategia.resumo},
        prob_alta_15d:a.probabilidades.horizonte_15d.prob_alta,preco:a.preco
      })),
      decisoes_sugeridas:briefing.decisoesSugeridas});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Status do pipeline do agente (logs das últimas execuções)
app.get('/agente/pipeline', autenticar, async (req,res) => {
  const { data: relatorios } = await supabase.from('relatorios_agente')
    .select('data,tipo,conteudo,decisoes_sugeridas,canal_enviado,criado_em')
    .eq('perfil_id', req.perfil.id)
    .order('criado_em', {ascending:false}).limit(7);

  const { data: estrategias } = await supabase.from('estrategias_venda')
    .select('cultura,pct_vender_agora,pct_travar,pct_aguardar,motivo_principal,market_timing_score,confianca,validade,criado_em')
    .eq('perfil_id', req.perfil.id)
    .gt('validade', new Date().toISOString())
    .order('criado_em', {ascending:false}).limit(8);

  res.json({ ok:true,
    ultimas_execucoes: relatorios || [],
    estrategias_ativas: estrategias || [],
    proxima_execucao: '8:00h todos os dias (horário de Brasília)'
  });
});

app.get('/agente/historico', autenticar, async (req,res) => {
  const {data}=await supabase.from('relatorios_agente').select('*')
    .eq('perfil_id',req.perfil.id).order('criado_em',{ascending:false}).limit(30);
  res.json({ok:true,relatorios:data||[]});
});

// ══════════ CHAT IA ═══════════════════════════════════════════
app.post('/chat', autenticar, limChat, async (req,res) => {
  const {pergunta}=req.body;
  if (!pergunta||pergunta.length<3) return res.status(400).json({erro:'Pergunta muito curta.'});
  if (pergunta.length>1000) return res.status(400).json({erro:'Pergunta muito longa.'});
  if(!(await temRecurso(req.perfil.id,'chat_ia')))
    return res.status(403).json({erro:'Chat IA nos planos Pro e Premium.'});
  try {
    const [precos,ctx]=await Promise.all([
      buscarTodosPrecos(supabase),
      buscarCtx(req.perfil.id,req.perfil.culturas_interesse?.[0]||'soja')
    ]);
    const contexto=
      `Você é o AgroVenda AI, gerente comercial digital de ${req.perfil.nome.split(' ')[0]}.\n` +
      `Linguagem simples, direta, máximo 3 parágrafos.\n` +
      `Perfil: objetivo=${ctx.objetivoProd}, risco=${ctx.perfilRisco}\n` +
      `Dólar: R$ ${precos.dolar?.toFixed(2)||'N/D'}\n` +
      Object.entries(precos.precos||{}).filter(([,v])=>v.brl).slice(0,4)
        .map(([c,v])=>`${c}: R$ ${v.brl.toLocaleString('pt-BR')}`).join(' | ') +
      `\n\nPERGUNTA: ${pergunta}`;
    const iaRes=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:600,messages:[{role:'user',content:contexto}]}),
      timeout:30000
    });
    const data=await iaRes.json();
    const resposta=(data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    await supabase.from('chat_ia').insert({
      perfil_id:req.perfil.id,canal:'app',pergunta:pergunta.substring(0,2000),
      resposta:resposta.substring(0,4000),dados_utilizados:{dolar:precos.dolar},
      tokens_usados:(data.usage?.input_tokens||0)+(data.usage?.output_tokens||0),
      custo_usd:((data.usage?.input_tokens||0)*0.000003)+((data.usage?.output_tokens||0)*0.000015)
    }).catch(()=>{});
    await registrarUsoIA(req.perfil.id,data.usage?.input_tokens||200,data.usage?.output_tokens||300,supabase);
    res.json({ok:true,resposta,pergunta});
  } catch(e) { res.status(500).json({erro:e.message}); }
});
app.get('/chat/historico', autenticar, async (req,res) => {
  const {data}=await supabase.from('chat_ia').select('pergunta,resposta,canal,criado_em')
    .eq('perfil_id',req.perfil.id).order('criado_em',{ascending:false}).limit(50);
  res.json({ok:true,historico:data||[]});
});

// ══════════ ANÁLISE IA ════════════════════════════════════════
app.post('/analisar', autenticar, limIA, validarCultura, async (req,res) => {
  const {cultura,prompt,custo_saca}=req.body;
  if (!prompt||prompt.length>8000) return res.status(400).json({erro:'Prompt obrigatório (max 8000 chars).'});
  const lim=await verificarLimiteIA(req.perfil.id,req.limite.analises_dia,supabase);
  if (!lim.permitido) return res.status(429).json({
    erro:`Limite: ${lim.usadas}/${lim.limite} análises.`,upgrade_url:(process.env.FRONTEND_URL||'')+'/planos'});
  try {
    const [precos,ctx]=await Promise.all([buscarTodosPrecos(supabase),buscarCtx(req.perfil.id,cultura)]);
    const p=precos.precos[cultura];
    const score=calcularScore({
      cultura,precoAtual:p?.brl,precoMedia60d:p?.media60d,preco7dAtras:p?.preco7dAtras,
      dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
      custoProd:custo_saca||ctx.custoProd,estoqueStatus:'neutro',volatilidadeAlta:false,...ctx
    });
    const probs=await calcularProbabilidadeComML({
      cultura,precoAtual:p?.brl,precoMedia60d:p?.media60d,preco7dAtras:p?.preco7dAtras,
      dolar:precos.dolar,dolarMedia30d:precos.dolarMedia30d,
      historicoPrecos:ctx.historicoPrecos,estoqueStatus:'neutro',climaImpacto:ctx.climaImpacto
    });
    const estrategia=gerarEstrategia({
      cultura,score9var:score.score,probabilidades:probs,
      objetivo:ctx.objetivoProd,perfilRisco:ctx.perfilRisco,
      dividaAtiva:ctx.dividaAtiva,precisaCaixa:ctx.precisaCaixa,
      sacasEstoque:ctx.sacasEstoque,custoProd:custo_saca||ctx.custoProd,
      precoAtual:p?.brl,dolar:precos.dolar,climaImpacto:ctx.climaImpacto,estoqueStatus:'neutro'
    });
    const promptFinal=prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'')+
      `\n\nDADOS REAIS — AgroVenda AI v6:\n`+
      `Dólar PTAX: R$ ${precos.dolar?.toFixed(2)||'N/D'}\n`+
      `Preço ${cultura}: ${p?.brl?`R$ ${p.brl.toLocaleString('pt-BR')} (${p.fonte})`:'N/D'}\n`+
      `Score v6: ${score.score}/100 | MTS: ${estrategia.market_timing.score}/100\n`+
      `Estratégia: vender ${estrategia.pct_vender_agora}% / travar ${estrategia.pct_travar}% / aguardar ${estrategia.pct_aguardar}%\n`+
      `Prob alta 15d: ${probs.horizonte_15d.prob_alta}% | Queda: ${probs.horizonte_15d.prob_queda}%\n`+
      Object.entries(score.itens).map(([k,v])=>`  ${k}: ${v.pts}/${v.max}pts — ${v.desc}`).join('\n');
    const iaRes=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:2000,
        tools:[{type:'web_search_20250305',name:'web_search'}],
        messages:[{role:'user',content:promptFinal}]}),
      timeout:90000
    });
    const data=await iaRes.json();
    if (!iaRes.ok) return res.status(500).json({erro:data?.error?.message||'Erro IA.'});
    await registrarUsoIA(req.perfil.id,data.usage?.input_tokens||1000,data.usage?.output_tokens||800,supabase);

    // Logar recomendação exibida + aplicar linguagem moderada
    const textoResp = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const logId = await logarRecomendacao(supabase,{
      user_id:req.perfil.id, cultura,
      recomendacao_exibida: textoResp.substring(0,2000),
      preco_momento:p?.brl, dolar_momento:precos.dolar,
      score:score.score, market_timing_score:estrategia.market_timing?.score,
      probabilidade_alta:probs.horizonte_15d?.prob_alta,
      probabilidade_queda:probs.horizonte_15d?.prob_queda,
      confianca:score.confianca,
      indicadores:score.itens,
      fatores_externos:{clima:ctx.climaImpacto,dolar_media_30d:precos.dolarMedia30d},
      contexto_produtor:{objetivo:ctx.objetivoProd,risco:ctx.perfilRisco,divida:ctx.dividaAtiva},
      tokens_usados:(data.usage?.input_tokens||0)+(data.usage?.output_tokens||0),
      disclaimer_exibido:true
    }).catch(()=>null);
    const texto=(data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    try {
      const m=texto.match(/\{[\s\S]*\}/);
      if (m) {
        const an=JSON.parse(m[0]);
        await supabase.from('analises').insert({
          perfil_id:req.perfil.id,cultura,veredito:an.veredito||score.acao,
          score:an.score||score.score,confianca:score.confianca,resumo:an.resumo||'',
          analise_completa:{...an,score_quantitativo:score,estrategia,probabilidades:probs},
          preco_na_analise:p?.brl,dolar_na_analise:precos.dolar,modelo_ia:'claude-sonnet-4-20250514'
        });
        await log(supabase,{perfil_id:req.perfil.id,evento:EVENTOS.ANALISE_FEITA,nivel:'info',
          detalhe:{cultura,score:score.score,mts:estrategia.market_timing.score}});
        // Onboarding passo 5: primeira análise recebida
        supabase.from('onboarding_progresso').update({passo_5_analise:true,atualizado_em:new Date().toISOString()})
          .eq('perfil_id',req.perfil.id).catch(()=>{});
      }
    } catch(e) {
      await log(supabase,{perfil_id:req.perfil.id,evento:'analise_parse_falhou',nivel:'aviso',
        detalhe:{erro:e.message,texto_ia:texto.substring(0,300)}});
    }
    // Análise de riscos estruturada
    const analiseRiscos = gerarAnaliseRiscos(score, probs, {
      dolar_ptax: precos.dolar, dolar_media_30d: precos.dolarMedia30d,
      clima_impacto: ctx.climaImpacto
    }, cultura);

    res.json({...data,_meta:{score_quantitativo:score,estrategia,probabilidades:probs,
      market_timing:estrategia.market_timing,
      restantes_hoje:lim.restantes-1,
      analise_riscos: gerarAnaliseRiscos(score,probs,{dolar_ptax:precos.dolar,dolar_media_30d:precos.dolarMedia30d,clima_impacto:ctx.climaImpacto},cultura),
      disclaimer: DISCLAIMER,
      log_id: logId,
      linguagem_verificada: verificarLinguagem(textoResp.substring(0,500)).ok
    }});
  } catch(e) {
    await log(supabase,{perfil_id:req.perfil.id,evento:EVENTOS.ERRO_IA,nivel:'erro',detalhe:{erro:e.message}});
    res.status(500).json({erro:e.message});
  }
});

// ══════════ GATILHOS, INTELIGÊNCIA, SIMULAÇÃO, RADAR ══════════
app.post('/gatilhos', autenticar, validarCultura, async (req,res) => {
  const {cultura,tipo,condicao,acao,mensagem_custom,percentual_sugerido}=req.body;
  if (!tipo||!condicao||!acao) return res.status(400).json({erro:'tipo, condicao e acao obrigatórios.'});
  const {data,error}=await supabase.from('gatilhos').insert({
    perfil_id:req.perfil.id,cultura,tipo,condicao,acao,mensagem_custom,percentual_sugerido,ativo:true
  }).select().single();
  if (error) return res.status(500).json({erro:error.message});
  res.json({ok:true,gatilho:data});
});
app.get('/gatilhos', autenticar, async (req,res) => {
  const {data}=await supabase.from('gatilhos').select('*').eq('perfil_id',req.perfil.id);
  res.json({ok:true,gatilhos:data||[]});
});
app.delete('/gatilhos/:id', autenticar, async (req,res) => {
  if(!(await verOwnership('gatilhos',req.params.id,req.perfil.id))) return res.status(404).json({erro:'Não encontrado.'});
  await supabase.from('gatilhos').update({ativo:false}).eq('id',req.params.id);
  res.json({ok:true});
});
app.get('/inteligencia/:cultura', autenticar, validarCultura, async (req,res) => {
  const {data:pp}=await supabase.from('produtor_perfil').select('perfil_risco').eq('perfil_id',req.perfil.id).single();
  const {data}=await supabase.rpc('padrao_coletivo',{
    p_cultura:req.params.cultura,p_score_min:parseInt(req.query.score_min)||60,
    p_score_max:parseInt(req.query.score_max)||80,p_perfil_risco:pp?.perfil_risco||null
  });
  res.json({ok:true,padrao:data,cultura:req.params.cultura});
});
app.post('/simulacao', autenticar, validarCultura, async (req,res) => {
  if(!(await temRecurso(req.perfil.id,'simulacoes')))
    return res.status(403).json({erro:'Simulações a partir do plano Básico.'});
  const {cultura,quantidade,preco,custo,prazo_dias}=req.body;
  if (!quantidade||!preco||!custo) return res.status(400).json({erro:'quantidade, preco e custo obrigatórios.'});
  const {simular}=require('./simulacao');
  const resultado=simular({quantidade,preco,custo,prazo_dias});
  if (!resultado.erro) await supabase.from('simulacoes').insert({
    perfil_id:req.perfil.id,cultura,quantidade_sacas:quantidade,preco_simulado:preco,custo_saca:custo,prazo_dias:prazo_dias||0
  }).catch(()=>{});
  res.json({ok:!resultado.erro,...resultado});
});
app.get('/radar', autenticar, async (req,res) => {
  if(!(await temRecurso(req.perfil.id,'radar')))
    return res.status(403).json({erro:'Radar disponível a partir do plano Básico.'});
  const oportunidades=await buscarOportunidadesAtivas(supabase,req.perfil.culturas_interesse,10);
  res.json({ok:true,oportunidades,total:oportunidades.length});
});

// ══════════ DECISÕES ══════════════════════════════════════════
app.post('/decisoes', autenticar, validarCultura, async (req,res) => {
  if(!(await temRecurso(req.perfil.id,'decisoes'))) return res.status(403).json({erro:'Histórico no plano Pro.'});
  const {cultura,decisao,quantidade_sacas,preco_executado,score_no_momento,recomendacao_recebida}=req.body;
  if (!cultura||!decisao) return res.status(400).json({erro:'cultura e decisao obrigatórios.'});
  const { motivo_externo, seguiu_recomendacao, notas_produtor } = req.body;

  // Validar motivo_externo contra lista conhecida
  const MOTIVOS_VALIDOS = ['preco_bom','necessidade_cx','medo_queda','recomendacao_ia','contrato','cliente_exigiu','outro'];
  const motivoValido = motivo_externo && MOTIVOS_VALIDOS.includes(motivo_externo) ? motivo_externo : null;

  // Determinar se conta para aprendizado do modelo
  const contaParaModelo = !motivoValido || motivoAfetaModelo(motivoValido);

  const {data,error}=await supabase.from('decisoes').insert({
    perfil_id:req.perfil.id,cultura,decisao,quantidade_sacas,preco_executado,
    score_no_momento,recomendacao_recebida,
    motivo_externo:motivoValido,
    seguiu_recomendacao: seguiu_recomendacao ?? null,
    data_decisao:new Date().toISOString().split('T')[0],
    aprendizado: notas_produtor || (motivoValido && !contaParaModelo
      ? `Decisão por ${motivoValido} — não reflete timing de mercado.` : null)
  }).select().single();
  if (error) return res.status(500).json({erro:error.message});
  res.json({ok:true,decisao:data});
});
app.patch('/decisoes/:id/resultado', autenticar, async (req,res) => {
  if(!(await verOwnership('decisoes',req.params.id,req.perfil.id))) return res.status(404).json({erro:'Não encontrado.'});
  const {resultado,preco_posterior,aprendizado,quantidade_sacas,preco_executado}=req.body;
  const ganho_perdido=quantidade_sacas&&preco_posterior&&preco_executado?(preco_posterior-preco_executado)*quantidade_sacas:null;
  if (resultado) {
    const {data:pp}=await supabase.from('produtor_perfil').select('perfil_risco,objetivo').eq('perfil_id',req.perfil.id).single();
    const {data:dd}=await supabase.from('decisoes').select('cultura,score_no_momento').eq('id',req.params.id).single();
    if (dd) await supabase.from('inteligencia_coletiva').insert({
      cultura:dd.cultura,perfil_risco:pp?.perfil_risco,objetivo:pp?.objetivo,
      score_no_momento:dd.score_no_momento,decisao:req.body.decisao_original||'desconhecido',
      resultado,ganho_percentual:ganho_perdido&&preco_executado?(ganho_perdido/preco_executado*100):null,horizon_dias:30
    }).catch(()=>{});
  }
  await supabase.from('decisoes').update({resultado,preco_posterior,aprendizado,ganho_perdido}).eq('id',req.params.id);
  // Atualizar memória operacional após registrar resultado
  atualizarMemoria(supabase, req.perfil.id).catch(()=>{});
  res.json({ok:true});
});
app.get('/decisoes', autenticar, async (req,res) => {
  const cultura = req.query.cultura && CULTURAS_VALIDAS.has(req.query.cultura)
    ? req.query.cultura : null;
  let q = supabase.from('decisoes').select('*')
    .eq('perfil_id',req.perfil.id).order('data_decisao',{ascending:false}).limit(50);
  if (cultura) q = q.eq('cultura', cultura);
  const {data} = await q;
  const comRes = (data||[]).filter(d=>d.resultado);
  const totalG = (data||[]).reduce((s,d)=>s+(d.ganho_perdido||0),0);
  res.json({ok:true, decisoes:data||[],
    estatisticas:{
      total: data?.length||0,
      com_resultado: comRes.length,
      ganho_total_estimado: Math.round(totalG),
    },
    motivos_disponiveis: 'GET /decisoes/motivos'
  });
});

// ══════════ ALERTAS + CLIMA + FAZENDAS ════════════════════════
app.post('/alertas/configurar', autenticar, validarCultura, async (req,res) => {
  const {cultura,preco_alvo,percentual_venda}=req.body;
  if (!cultura||!preco_alvo) return res.status(400).json({erro:'cultura e preco_alvo obrigatórios.'});
  const {data:ativos}=await supabase.from('configuracoes_alertas').select('id').eq('perfil_id',req.perfil.id).eq('alerta_ativo',true);
  if((ativos?.length||0)>=req.limite.alertas_ativos) return res.status(403).json({erro:`Limite de alertas do plano ${req.perfil.plano}.`});
  await supabase.from('configuracoes_alertas').upsert(
    {perfil_id:req.perfil.id,cultura,preco_alvo,percentual_venda:percentual_venda||30,alerta_ativo:true},
    {onConflict:'perfil_id,cultura'});
  // Onboarding passo 6
  supabase.from('onboarding_progresso').update({passo_6_alerta:true,atualizado_em:new Date().toISOString()})
    .eq('perfil_id',req.perfil.id).catch(()=>{});
  res.json({ok:true,mensagem:`Alerta: ${cultura} @ R$ ${preco_alvo}`});
});
app.get('/alertas/meus', autenticar, async (req,res) => {
  const {data}=await supabase.from('configuracoes_alertas').select('*').eq('perfil_id',req.perfil.id);
  res.json({ok:true,alertas:data||[]});
});
app.get('/alertas/historico', autenticar, async (req,res) => {
  const {data}=await supabase.from('alertas').select('*').eq('perfil_id',req.perfil.id)
    .order('criado_em',{ascending:false}).limit(50);
  res.json({ok:true,historico:data||[]});
});
app.get('/clima/:estado', autenticar, async (req,res) => {
  const {buscarPrevisaoClima}=require('./clima');
  const estados=['MT','PR','MG','GO','MS','SP','BA','RS'];
  const estado=req.params.estado.toUpperCase();
  if(!estados.includes(estado)) return res.status(400).json({erro:'Estado inválido.'});
  const dados=await buscarPrevisaoClima(estado);
  if(!dados) return res.status(503).json({erro:'Clima indisponível.'});
  res.json({ok:true,...dados});
});
app.get('/fazendas', autenticar, async (req,res) => {
  const {data}=await supabase.from('fazendas').select('*,custos_producao(*)').eq('perfil_id',req.perfil.id);
  res.json({ok:true,fazendas:data||[]});
});
app.post('/fazendas', autenticar, async (req,res) => {
  const {nome,municipio,estado,area_ha}=req.body;
  if(!nome) return res.status(400).json({erro:'Nome obrigatório.'});
  const {data,error}=await supabase.from('fazendas').insert({perfil_id:req.perfil.id,nome,municipio,estado,area_ha}).select().single();
  if(error) return res.status(500).json({erro:error.message});
  res.json({ok:true,fazenda:data});
});
app.post('/fazendas/:id/custos', autenticar, async (req,res) => {
  if(!(await verOwnership('fazendas',req.params.id,req.perfil.id))) return res.status(404).json({erro:'Fazenda não encontrada.'});
  const {cultura,safra,custo_ha,produtividade_sc_ha,area_plantada_ha}=req.body;
  if(!cultura||!safra||!custo_ha||!produtividade_sc_ha) return res.status(400).json({erro:'Campos obrigatórios faltando.'});
  const {data,error}=await supabase.from('custos_producao').upsert(
    {fazenda_id:req.params.id,cultura,safra,custo_ha,produtividade_sc_ha,area_plantada_ha},
    {onConflict:'fazenda_id,cultura,safra'}).select().single();
  if(error) return res.status(500).json({erro:error.message});
  res.json({ok:true,custo:data});
});

// ══════════ TELEGRAM + WHATSAPP + PAGAMENTOS ══════════════════
app.post('/telegram/cadastrar', autenticar, async (req,res) => {
  const {bot_token,chat_id}=req.body;
  if(!bot_token||!chat_id) return res.status(400).json({erro:'bot_token e chat_id obrigatórios.'});
  await supabase.from('perfis').update({telegram_bot_token:bot_token,telegram_chat_id:chat_id}).eq('id',req.perfil.id);
  const msg=`✅ <b>AgroVenda AI v6 conectado!</b>\n\nOlá, <b>${req.perfil.nome}</b>!\n🤖 AI Agent ativo\n📊 Dados reais CEPEA/ESALQ\n🎯 Sinais preditivos\n📈 Backtesting em tempo real\n\n<i>AgroVenda Pro AI v6</i>`;
  const r=await enviarTelegram(bot_token,chat_id,msg);
  await log(supabase,{perfil_id:req.perfil.id,evento:EVENTOS.TELEGRAM_CONFIG,nivel:'info',detalhe:{ok:r.ok}});
  if (r.ok) {
    supabase.from('onboarding_progresso').update({passo_7_telegram:true,atualizado_em:new Date().toISOString()})
      .eq('perfil_id',req.perfil.id).catch(()=>{});
  }
  res.json({ok:true,telegram_confirmado:r.ok});
});
app.post('/telegram/enviar', autenticar, async (req,res) => {
  const {telegram_bot_token,telegram_chat_id}=await getBotToken(supabase,req.perfil.id);
  if(!telegram_bot_token) return res.status(400).json({erro:'Telegram não configurado.'});
  await enfileirar(supabase,{perfil_id:req.perfil.id,tipo:'manual',mensagem:req.body.mensagem,destino_bot:telegram_bot_token,destino_chat:telegram_chat_id});
  res.json({ok:true});
});
app.post('/whatsapp/webhook', async (req,res) => {
  if(req.query.hub_verify_token===process.env.WHATSAPP_VERIFY_TOKEN) return res.send(req.query.hub_challenge);
  processarWhatsApp(supabase,req.body).catch(e=>console.error('WA:',e.message));
  res.sendStatus(200);
});
app.post('/pagamentos/criar-link', autenticar, async (req,res) => {
  if(!process.env.MP_ACCESS_TOKEN) return res.status(503).json({erro:'Pagamento não configurado.'});
  try { const link=await criarLinkMP(req.perfil.id,req.body.plano,req.body.periodo_meses||1); res.json({ok:true,link}); }
  catch(e) { res.status(500).json({erro:e.message}); }
});
app.post('/pagamentos/mercadopago', async (req,res) => { await processarMercadoPago(supabase,req.body,req.headers); res.sendStatus(200); });
app.post('/pagamentos/asaas', async (req,res) => { await processarAsaas(supabase,req.body,req.headers); res.sendStatus(200); });
app.post('/pagamentos/stripe', express.raw({type:'application/json'}), async (req,res) => {
  await processarStripe(supabase,JSON.parse(req.body),req.body,req.headers['stripe-signature']); res.sendStatus(200);
});

// ══════════ EXPLICABILIDADE E JORNADA (v10) ══════════════════

// "Por que a IA recomendou isso?" — explicação de uma análise
app.post('/explicar', autenticar, validarCultura, async (req,res) => {
  const {cultura, score_data, custo_saca} = req.body;
  if (!cultura) return res.status(400).json({erro:'cultura obrigatória.'});
  try {
    const [precos, ctx, mem] = await Promise.all([
      buscarTodosPrecos(supabase),
      buscarCtx(req.perfil.id, cultura),
      buscarMemoria(supabase, req.perfil.id)
    ]);
    const p = precos.precos[cultura];
    const score = calcularScore({
      cultura, precoAtual:p?.brl, precoMedia60d:p?.media60d,
      preco7dAtras:p?.preco7dAtras, dolar:precos.dolar,
      dolarMedia30d:precos.dolarMedia30d,
      custoProd:custo_saca||ctx.custoProd,
      estoqueStatus:'neutro',volatilidadeAlta:false,...ctx
    });
    const probs = await calcularProbabilidadeComML({
      cultura, precoAtual:p?.brl, precoMedia60d:p?.media60d,
      preco7dAtras:p?.preco7dAtras, dolar:precos.dolar,
      dolarMedia30d:precos.dolarMedia30d,
      historicoPrecos:ctx.historicoPrecos,
      estoqueStatus:'neutro', climaImpacto:ctx.climaImpacto
    });
    const explicacao = explicarRecomendacao(score, probs, {
      preco_brl:p?.brl, media_60d:p?.media60d, dolar_ptax:precos.dolar,
      clima_impacto:ctx.climaImpacto, volatilidade_20d:null,
      fonte:p?.fonte, data_dado:new Date().toISOString().split('T')[0]
    }, cultura, mem);
    res.json({ok:true, ...explicacao});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Motivos disponíveis para registrar uma decisão
app.get('/decisoes/motivos', autenticar, (req,res) => {
  res.json({ok:true, motivos: MOTIVOS_DECISAO,
    nota:'Use o campo motivo_externo ao registrar uma decisão para melhorar o aprendizado do sistema.'});
});

// "Minha jornada de decisões" — linha do tempo
app.get('/jornada', autenticar, async (req,res) => {
  try {
    const cultura = req.query.cultura && CULTURAS_VALIDAS.has(req.query.cultura)
      ? req.query.cultura : null;
    const jornada = await buscarJornada(supabase, req.perfil.id, cultura);
    res.json({ok:true, ...jornada});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Perfil comportamental do produtor
app.get('/perfil/decisao', autenticar, async (req,res) => {
  try {
    const [decisoesRow, mem] = await Promise.all([
      supabase.from('decisoes')
        .select('decisao,score_no_momento,motivo_externo,seguiu_recomendacao,ganho_perdido,resultado,data_decisao')
        .eq('perfil_id',req.perfil.id)
        .order('data_decisao',{ascending:false}).limit(50),
      buscarMemoria(supabase, req.perfil.id)
    ]);
    const perfil_decisao = calcularPerfilDecisao(decisoesRow.data||[], mem);
    res.json({ok:true, perfil_decisao, memoria_resumo: mem.consolidada});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// ══════════ COMPLIANCE JURÍDICO E LGPD (v9) ═════════════════

// Documentos legais (termos, privacidade, uso_ia, aviso_riscos)
app.get('/legal', async (req,res) => {
  const {data} = await supabase.from('legal_documents')
    .select('tipo,versao,titulo,resumo,vigencia_desde').eq('ativo',true).order('tipo');
  res.json({ok:true, documentos:data||[]});
});

app.get('/legal/:tipo', async (req,res) => {
  const {data} = await supabase.from('legal_documents')
    .select('*').eq('tipo',req.params.tipo).eq('ativo',true).single();
  if (!data) return res.status(404).json({erro:'Documento não encontrado.'});
  res.json({ok:true, documento:data});
});

// Registrar consentimento — chamado ao aceitar termos
app.post('/consentimento', autenticar, async (req,res) => {
  const {tipo, versao} = req.body;
  if (!tipo||!versao) return res.status(400).json({erro:'tipo e versao obrigatórios.'});
  try {
    const consent = await registrarConsentimento(
      supabase, req.perfil.id, tipo, versao, getIP(req), req.headers['user-agent']
    );
    res.json({ok:true, consent_id:consent.id,
      mensagem:`Consentimento para ${tipo} v${versao} registrado.`});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Aceitar todos de uma vez (onboarding)
app.post('/consentimento/todos', autenticar, async (req,res) => {
  try {
    const {data:docs} = await supabase.from('legal_documents')
      .select('tipo,versao').eq('obrigatorio',true).eq('ativo',true);
    const ip = getIP(req);
    const ua = req.headers['user-agent'];
    const resultados = await Promise.all(
      (docs||[]).map(d => registrarConsentimento(supabase,req.perfil.id,d.tipo,d.versao,ip,ua).catch(()=>null))
    );
    res.json({ok:true, aceitos:resultados.filter(Boolean).length, total:docs?.length||0});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Verificar status dos consentimentos
app.get('/consentimento/status', autenticar, async (req,res) => {
  try {
    const status = await verificarConsentimentos(supabase, req.perfil.id);
    res.json({ok:true, ...status});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Aceite do disclaimer de uma recomendação específica
app.post('/consentimento/disclaimer/:log_id', autenticar, async (req,res) => {
  await registrarAceiteDisclaimer(supabase, req.params.log_id);
  res.json({ok:true});
});

// Registrar ação após recomendação
app.post('/compliance/acao/:log_id', autenticar, async (req,res) => {
  const {acao} = req.body;
  await registrarAcaoUsuario(supabase, req.params.log_id, acao);
  res.json({ok:true});
});

// Confirmar decisão comercial (com texto explícito de responsabilidade)
app.post('/compliance/confirmar-decisao', autenticar, async (req,res) => {
  const {cultura,decisao,quantidade_sacas,preco_executado,score_no_momento,recomendacao_recebida,log_id} = req.body;
  if (!cultura||!decisao) return res.status(400).json({erro:'cultura e decisao obrigatórios.'});
  try {
    const dec = await confirmarDecisaoComercial(supabase, req.perfil.id, {
      cultura,decisao,quantidade_sacas,preco_executado,
      score_no_momento,recomendacao_recebida,log_id
    });
    res.json({ok:true, decisao_id:dec.id,
      confirmacao: TEXTO_CONFIRMACAO_DECISAO,
      mensagem:'Sua decisão foi registrada com confirmação explícita.'
    });
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// ── PRIVACIDADE E LGPD ────────────────────────────────────────

// Ver e atualizar configurações de privacidade
app.get('/privacidade', autenticar, async (req,res) => {
  const {data} = await supabase.from('privacy_settings').select('*').eq('user_id',req.perfil.id).single();
  res.json({ok:true, configuracoes:data||{marketing_allowed:false,data_processing_allowed:true,analytics_allowed:true}});
});

app.put('/privacidade', autenticar, async (req,res) => {
  const {marketing_allowed,analytics_allowed,third_party_allowed} = req.body;
  await supabase.from('privacy_settings').upsert({
    user_id:req.perfil.id, marketing_allowed, analytics_allowed, third_party_allowed,
    data_processing_allowed:true,  // obrigatório para funcionar
    updated_at:new Date().toISOString()
  },{onConflict:'user_id'});
  res.json({ok:true});
});

// Exportar meus dados (LGPD portabilidade)
app.get('/privacidade/exportar', autenticar, async (req,res) => {
  try {
    const dados = await exportarDadosUsuario(supabase, req.perfil.id);
    res.setHeader('Content-Disposition','attachment; filename="meus-dados-agrovenda.json"');
    res.setHeader('Content-Type','application/json');
    res.json(dados);
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Solicitar exclusão de conta (LGPD direito ao esquecimento)
app.post('/privacidade/excluir-conta', autenticar, async (req,res) => {
  const {motivo, confirma} = req.body;
  if (!confirma) return res.status(400).json({
    erro:'Confirmação obrigatória.',
    mensagem:'Envie {confirma:true} para confirmar a solicitação de exclusão.'
  });
  try {
    const resultado = await solicitarExclusaoConta(supabase, req.perfil.id, motivo);
    res.json({ok:true,...resultado});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// ── INCIDENTES ────────────────────────────────────────────────

app.post('/incidente', autenticar, async (req,res) => {
  const {tipo,titulo,descricao,severidade} = req.body;
  if (!descricao) return res.status(400).json({erro:'Descrição obrigatória.'});
  const {data,error} = await supabase.from('incident_reports').insert({
    user_id:req.perfil.id, tipo:tipo||'reclamacao', titulo, descricao,
    severidade:severidade||'baixa', status:'aberto',
    dados_tecnicos:{plano:req.perfil.plano,culturas:req.perfil.culturas_interesse}
  }).select().single();
  if (error) return res.status(500).json({erro:error.message});
  res.json({ok:true, incidente_id:data.id,
    mensagem:'Incidente registrado. Nossa equipe vai analisar em breve.'});
});

app.get('/incidente', autenticar, async (req,res) => {
  const {data} = await supabase.from('incident_reports')
    .select('id,tipo,titulo,status,resolucao,criado_em,resolvido_em')
    .eq('user_id',req.perfil.id).order('criado_em',{ascending:false}).limit(20);
  res.json({ok:true, incidentes:data||[]});
});

// ══════════ CENTRAL DE AJUDA E SUPORTE ══════════════════════

// Onboarding — progresso de configuração
app.get('/onboarding', autenticar, async (req,res) => {
  try {
    const resultado = await calcularOnboarding(supabase, req.perfil.id);
    res.json({ok:true,...resultado});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Central de ajuda — listar artigos por categoria
app.get('/suporte/ajuda', autenticar, async (req,res) => {
  try {
    const {categoria} = req.query;
    const artigos = await listarArtigos(supabase, categoria||null);
    // Agrupar por categoria
    const agrupado = artigos.reduce((acc,a) => {
      if (!acc[a.categoria]) acc[a.categoria] = [];
      acc[a.categoria].push(a);
      return acc;
    }, {});
    res.json({ok:true, categorias:CATEGORIAS, artigos:agrupado, total:artigos.length});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Buscar artigo específico por slug
app.get('/suporte/ajuda/:slug', autenticar, async (req,res) => {
  try {
    const artigo = await buscarArtigo(supabase, req.params.slug);
    if (!artigo) return res.status(404).json({erro:'Artigo não encontrado.'});
    res.json({ok:true, artigo});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Assistente IA de suporte — dúvidas sobre o sistema
app.post('/suporte/assistente', autenticar, async (req,res) => {
  const {pergunta} = req.body;
  if (!pergunta||pergunta.trim().length<3)
    return res.status(400).json({erro:'Pergunta muito curta.'});
  if (pergunta.length>500)
    return res.status(400).json({erro:'Pergunta muito longa (max 500 chars).'});
  try {
    const resultado = await assistenteSuporteIA(
      supabase, req.perfil.id, pergunta, process.env.ANTHROPIC_API_KEY
    );
    res.json({ok:true,...resultado});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Relatar problema — cria ticket com diagnóstico automático
app.post('/suporte/ticket', autenticar, async (req,res) => {
  const {tela,acao,mensagem_erro,descricao,categoria,urgencia,user_agent} = req.body;
  if (!descricao&&!mensagem_erro)
    return res.status(400).json({erro:'Descreva o problema ou informe a mensagem de erro.'});
  try {
    const resultado = await criarTicket(supabase, req.perfil.id, {
      tela,acao,mensagem_erro,descricao,categoria,urgencia,user_agent
    });
    res.json({ok:true,
      ticket_id: resultado.ticket.id,
      status: resultado.ticket.status,
      artigo_sugerido: resultado.artigo_sugerido,
      mensagem: resultado.artigo_sugerido
        ? 'Encontramos um artigo que pode resolver sua dúvida!'
        : 'Ticket registrado. Nossa equipe vai analisar em breve.'
    });
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Ver meus tickets
app.get('/suporte/tickets', autenticar, async (req,res) => {
  const {data} = await supabase.from('tickets_suporte')
    .select('id,categoria,descricao,status,resolucao,artigo_sugerido,criado_em,resolvido_em')
    .eq('perfil_id',req.perfil.id)
    .order('criado_em',{ascending:false}).limit(20);
  res.json({ok:true, tickets:data||[]});
});

// Fechar ticket + avaliar atendimento
app.patch('/suporte/tickets/:id', autenticar, async (req,res) => {
  const {avaliacao,resolucao_ok} = req.body;
  if (!(await verOwnership('tickets_suporte',req.params.id,req.perfil.id)))
    return res.status(404).json({erro:'Ticket não encontrado.'});
  await supabase.from('tickets_suporte').update({
    status:'fechado', avaliacao:avaliacao||null,
    resolvido_em:new Date().toISOString()
  }).eq('id',req.params.id);
  res.json({ok:true});
});

// Feedback de análise — 👍 ou 👎
app.post('/feedback', autenticar, async (req,res) => {
  const {analise_id,sinal_id,cultura,util,motivo} = req.body;
  if (util===undefined) return res.status(400).json({erro:'Campo util (true/false) obrigatório.'});
  try {
    const fb = await registrarFeedback(supabase, req.perfil.id, {analise_id,sinal_id,cultura,util,motivo});
    res.json({ok:true, feedback_id:fb.id,
      mensagem: util ? 'Obrigado! Seu feedback melhora nossas análises.' : 'Obrigado! Vamos usar isso para melhorar.'
    });
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Histórico de feedback do produtor
app.get('/feedback', autenticar, async (req,res) => {
  const {data} = await supabase.from('feedback_analises')
    .select('cultura,util,motivo,criado_em')
    .eq('perfil_id',req.perfil.id)
    .order('criado_em',{ascending:false}).limit(30);
  res.json({ok:true, feedbacks:data||[]});
});

// ══════════ ADMIN (v6) ════════════════════════════════════════
app.get('/admin/painel', autenticar, exigirAdmin, async (req,res) => {
  const [{data:painel},{data:qualidade},{data:accuracySinais}] = await Promise.all([
    supabase.from('painel_admin').select('*').single(),
    supabase.from('qualidade_dados').select('*'),
    supabase.from('accuracy_sinais').select('*')
  ]);
  res.json({ok:true,...painel,qualidade_dados:qualidade||[],accuracy_sinais:accuracySinais||[]});
});
app.get('/admin/assinantes', autenticar, exigirAdmin, async (req,res) => {
  const {data}=await supabase.from('perfis').select('id,nome,plano,ativo,validade,cargo,criado_em').order('criado_em',{ascending:false});
  res.json({ok:true,assinantes:data||[]});
});
app.patch('/admin/assinantes/:id', autenticar, exigirAdmin, async (req,res) => {
  const {ativo,plano,validade,cargo}=req.body;
  await supabase.from('perfis').update({ativo,plano,validade,cargo}).eq('id',req.params.id);
  res.json({ok:true});
});
app.get('/admin/logs', autenticar, exigirAdmin, async (req,res) => {
  let q=supabase.from('logs_eventos').select('*').order('criado_em',{ascending:false}).limit(200);
  if(req.query.nivel) q=q.eq('nivel',req.query.nivel);
  const {data}=await q;
  res.json({ok:true,logs:data||[]});
});
app.get('/admin/coleta/logs', autenticar, exigirAdmin, async (req,res) => {
  const {data}=await supabase.from('log_coletas').select('*').order('coletado_em',{ascending:false}).limit(100);
  res.json({ok:true,logs:data||[]});
});
// Trigger coleta manual (admin)
app.post('/admin/coleta/executar', autenticar, exigirAdmin, async (req,res) => {
  res.json({ok:true,msg:'Coleta iniciada em background'});
  cicloPrincipal(supabase,process.env.ANTHROPIC_API_KEY).catch(e=>console.error('Coleta manual:',e.message));
});
// Trigger backtesting manual (admin)
app.post('/admin/backtesting/avaliar', autenticar, exigirAdmin, async (req,res) => {
  res.json({ok:true,msg:'Avaliação de backtesting iniciada em background'});
  avaliarBacktesting(supabase).catch(e=>console.error('Backtesting manual:',e.message));
});
// Trigger backfill de dados históricos (admin)
app.post('/admin/backfill', autenticar, exigirAdmin, async (req,res) => {
  const limite=parseInt(req.body.limite)||2000;
  res.json({ok:true,msg:`Backfill de ${limite} registros iniciado em background`});
  backfillHistorico(supabase,limite).catch(e=>console.error('Backfill:',e.message));
});
// Exportar features para ML (admin)
app.get('/admin/ml/features/:cultura', autenticar, exigirAdmin, validarCultura, async (req,res) => {
  const {data,error}=await supabase.rpc('exportar_features_ml',{
    p_cultura:req.params.cultura,
    p_data_inicio:req.query.inicio||new Date(Date.now()-365*86400000).toISOString().split('T')[0],
    p_data_fim:req.query.fim||new Date().toISOString().split('T')[0]
  });
  if (error) return res.status(500).json({erro:error.message});
  res.json({ok:true,cultura:req.params.cultura,registros:data?.length||0,features:data||[]});
});
// Accuracy do modelo (admin)
app.get('/admin/ml/accuracy/:cultura', autenticar, exigirAdmin, validarCultura, async (req,res) => {
  const {data}=await supabase.rpc('accuracy_modelo',{
    p_cultura:req.params.cultura,
    p_horizonte:req.query.horizonte||'15d',
    p_inicio:req.query.inicio||new Date(Date.now()-90*86400000).toISOString().split('T')[0]
  });
  res.json({ok:true,...data});
});

// ══════════ MEMÓRIA OPERACIONAL (v8) ═════════════════════════

// Ver tudo que o sistema sabe sobre o produtor
app.get('/memoria', autenticar, async (req,res) => {
  try {
    const memoria = await buscarMemoria(supabase, req.perfil.id);
    const contextoIA = gerarContextoIA(memoria, req.query.cultura || null);
    res.json({ ok:true, ...memoria, contexto_ia: contextoIA });
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Produtor corrigir/complementar o que o sistema entendeu
app.put('/memoria', autenticar, async (req,res) => {
  const { resumo_custom, prefere_travar, sensivel_cambio, sensivel_clima, canal_preferido } = req.body;
  const updates = {};
  if (resumo_custom     !== undefined) updates.resumo_ia        = resumo_custom;
  if (prefere_travar    !== undefined) updates.prefere_travar   = prefere_travar;
  if (sensivel_cambio   !== undefined) updates.sensivel_cambio  = sensivel_cambio;
  if (sensivel_clima    !== undefined) updates.sensivel_clima   = sensivel_clima;
  if (canal_preferido   !== undefined) updates.canal_preferido  = canal_preferido;
  updates.ultima_atualizacao = new Date().toISOString();

  await supabase.from('memoria_produtor').upsert({
    perfil_id: req.perfil.id, ...updates
  }, { onConflict:'perfil_id' });
  res.json({ ok:true, mensagem:'Memória atualizada.' });
});

// Forçar recalcular memória
app.post('/memoria/recalcular', autenticar, async (req,res) => {
  try {
    const resultado = await atualizarMemoria(supabase, req.perfil.id);
    res.json({ ok:true, resultado });
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Eventos de aprendizado (log do que o sistema aprendeu)
app.get('/memoria/eventos', autenticar, async (req,res) => {
  const { data } = await supabase.from('eventos_aprendizado')
    .select('tipo,conteudo,impacto,criado_em')
    .eq('perfil_id', req.perfil.id)
    .order('criado_em', {ascending:false}).limit(50);
  res.json({ ok:true, eventos:data||[] });
});

// ── METAS DE SAFRA ────────────────────────────────────────────

app.post('/metas', autenticar, validarCultura, async (req,res) => {
  const { cultura, safra, preco_minimo, preco_meta, preco_sonho,
    volume_total_sc, prazo_limite, urgencia, observacoes } = req.body;
  if (!cultura||!safra) return res.status(400).json({erro:'cultura e safra obrigatórios.'});
  const { data, error } = await salvarMeta(supabase, req.perfil.id, {
    cultura, safra, preco_minimo, preco_meta, preco_sonho,
    volume_total_sc, prazo_limite, urgencia, observacoes
  });
  if (error) return res.status(500).json({erro:error.message});
  res.json({ ok:true, meta:data });
});

app.get('/metas', autenticar, async (req,res) => {
  const { data } = await supabase.from('metas_safra').select('*')
    .eq('perfil_id', req.perfil.id).eq('ativa', true)
    .order('criado_em', {ascending:false});
  res.json({ ok:true, metas:data||[] });
});

app.patch('/metas/:id/volume', autenticar, async (req,res) => {
  const { tipo, volume, cultura, safra } = req.body;
  if (!['vendido','travado'].includes(tipo)) return res.status(400).json({erro:'tipo: vendido|travado'});
  await atualizarVolumeMeta(supabase, req.perfil.id, cultura, safra, tipo, volume);
  res.json({ ok:true });
});

app.delete('/metas/:id', autenticar, async (req,res) => {
  await supabase.from('metas_safra').update({ativa:false}).eq('id',req.params.id).eq('perfil_id',req.perfil.id);
  res.json({ ok:true });
});

// ══════════ VALIDAÇÃO DE PREVISÕES (v7) ══════════════════════
// Dashboard completo — "Nos últimos 100 sinais: acerto X%, erro Y%"
app.get('/validacao', autenticar, async (req,res) => {
  try {
    const cultura = req.query.cultura || 'todas';
    if (cultura !== 'todas' && !CULTURAS_VALIDAS.has(cultura))
      return res.status(400).json({erro:'Cultura inválida.'});
    const dados = await dashboardValidacao(supabase, cultura);
    res.json({ok:true, ...dados});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Resumo dos últimos N sinais — endpoint direto
// GET /validacao/resumo?cultura=cafe&n=50&horizonte=15d
app.get('/validacao/resumo', autenticar, async (req,res) => {
  try {
    const cultura = req.query.cultura || 'todas';
    const n = Math.min(parseInt(req.query.n)||100, 500);
    const horizonte = ['7d','15d','30d'].includes(req.query.horizonte) ? req.query.horizonte : '15d';
    if (cultura !== 'todas' && !CULTURAS_VALIDAS.has(cultura))
      return res.status(400).json({erro:'Cultura inválida.'});
    const dados = await resumoUltimosN(supabase, cultura, n, horizonte);
    res.json({ok:true, ...dados});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Histórico paginado com resultado de cada sinal
app.get('/validacao/historico', autenticar, async (req,res) => {
  try {
    const cultura = req.query.cultura || null;
    const pagina = Math.max(1, parseInt(req.query.pagina)||1);
    const porPagina = Math.min(parseInt(req.query.por_pagina)||50, 200);
    const somenteAvaliados = req.query.avaliados === 'true';
    const dados = await historicoPaginado(supabase,{cultura,pagina,porPagina,somenteAvaliados});
    res.json({ok:true,...dados});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Accuracy por faixa de score
app.get('/validacao/por-score', autenticar, async (req,res) => {
  try {
    const cultura = req.query.cultura || 'todas';
    const dados = await validacaoPorScore(supabase, cultura);
    res.json({ok:true, cultura, faixas:dados,
      nota:'Mostra se score alto correlaciona com maior taxa de acerto.'});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Evolução mês a mês
app.get('/validacao/mensal', autenticar, async (req,res) => {
  try {
    const cultura = req.query.cultura && CULTURAS_VALIDAS.has(req.query.cultura)
      ? req.query.cultura : null;
    const dados = await validacaoMensal(supabase, cultura);
    res.json({ok:true, cultura:cultura||'todas', meses:dados});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Calibração do modelo (prob declarada vs realidade)
app.get('/validacao/calibracao', autenticar, async (req,res) => {
  try {
    const cultura = req.query.cultura || 'todas';
    const dados = await calibracao(supabase, cultura);
    res.json({ok:true, cultura, calibracao:dados,
      nota:'Diferença próxima de 0 = modelo bem calibrado.'});
  } catch(e) { res.status(500).json({erro:e.message}); }
});

// Detalhe de 1 sinal específico com resultado
app.get('/validacao/sinal/:id', autenticar, async (req,res) => {
  try {
    const dados = await detalhesSinal(supabase, req.params.id);
    res.json({ok:true,...dados});
  } catch(e) { res.status(e.message.includes('não encontrado')?404:500).json({erro:e.message}); }
});

// ══════════ ADMIN SUPORTE ════════════════════════════════════

app.get('/admin/suporte', autenticar, exigirAdmin, async (req,res) => {
  const [{data:painel},{data:tickets},{data:duvidas}] = await Promise.all([
    supabase.from('painel_suporte').select('*').single(),
    supabase.from('tickets_suporte')
      .select('id,categoria,descricao,status,urgencia,criado_em,perfis(nome,plano)')
      .in('status',['aberto','em_analise'])
      .order('criado_em').limit(50),
    supabase.from('duvidas_frequentes')
      .select('pergunta_padrao,total_vezes').eq('resolvida',false)
      .order('total_vezes',{ascending:false}).limit(20)
  ]);
  res.json({ok:true,painel:painel||{},tickets_abertos:tickets||[],duvidas_frequentes:duvidas||[]});
});

app.patch('/admin/suporte/tickets/:id', autenticar, exigirAdmin, async (req,res) => {
  const {status,resolucao} = req.body;
  const upd = {status,atualizado_em:new Date().toISOString()};
  if (resolucao) upd.resolucao = resolucao;
  if (status==='resolvido') upd.resolvido_em = new Date().toISOString();
  await supabase.from('tickets_suporte').update(upd).eq('id',req.params.id);
  res.json({ok:true});
});

app.get('/admin/suporte/artigos', autenticar, exigirAdmin, async (req,res) => {
  const {data} = await supabase.from('help_articles').select('*').order('categoria').order('ordem');
  res.json({ok:true,artigos:data||[]});
});

app.post('/admin/suporte/artigos', autenticar, exigirAdmin, async (req,res) => {
  const {categoria,slug,titulo,conteudo,conteudo_resumido,exemplo_pratico,video_url,palavras_chave,ordem} = req.body;
  if (!categoria||!slug||!titulo||!conteudo) return res.status(400).json({erro:'Campos obrigatórios faltando.'});
  const {data,error} = await supabase.from('help_articles').insert({
    categoria,slug,titulo,conteudo,conteudo_resumido,exemplo_pratico,
    video_url,palavras_chave:palavras_chave||[],ordem:ordem||99,ativo:true
  }).select().single();
  if (error) return res.status(500).json({erro:error.message});
  res.json({ok:true,artigo:data});
});

app.put('/admin/suporte/artigos/:id', autenticar, exigirAdmin, async (req,res) => {
  const {titulo,conteudo,conteudo_resumido,exemplo_pratico,video_url,palavras_chave,ativo,ordem} = req.body;
  await supabase.from('help_articles').update({
    titulo,conteudo,conteudo_resumido,exemplo_pratico,
    video_url,palavras_chave,ativo,ordem,atualizado_em:new Date().toISOString()
  }).eq('id',req.params.id);
  res.json({ok:true});
});

// ══════════ ADMIN COMPLIANCE ═════════════════════════════════

app.get('/admin/compliance', autenticar, exigirAdmin, async (req,res) => {
  const [{data:painel},{data:incidentes},{data:logs}] = await Promise.all([
    supabase.from('painel_compliance').select('*').single(),
    supabase.from('incident_reports')
      .select('id,tipo,titulo,severidade,status,criado_em,perfis(nome)')
      .in('status',['aberto','em_analise']).order('severidade',{ascending:false}).limit(30),
    supabase.from('ai_decision_logs')
      .select('user_id,cultura,score,acao_usuario,disclaimer_aceito,data_hora')
      .order('data_hora',{ascending:false}).limit(50)
  ]);
  res.json({ok:true,painel:painel||{},incidentes_abertos:incidentes||[],logs_recomendacoes:logs||[]});
});

app.patch('/admin/incidentes/:id', autenticar, exigirAdmin, async (req,res) => {
  const {status,resolucao} = req.body;
  const upd = {status};
  if (resolucao) upd.resolucao = resolucao;
  if (status==='resolvido') upd.resolvido_em = new Date().toISOString();
  await supabase.from('incident_reports').update(upd).eq('id',req.params.id);
  res.json({ok:true});
});

app.put('/admin/legal/:tipo', autenticar, exigirAdmin, async (req,res) => {
  const {versao,titulo,conteudo,resumo,obrigatorio} = req.body;
  if (!versao||!titulo||!conteudo) return res.status(400).json({erro:'versao, titulo e conteudo obrigatórios.'});
  const {data,error} = await supabase.from('legal_documents').upsert({
    tipo:req.params.tipo,versao,titulo,conteudo,resumo,
    obrigatorio:obrigatorio!==false,ativo:true,atualizado_em:new Date().toISOString()
  },{onConflict:'tipo'}).select().single();
  if (error) return res.status(500).json({erro:error.message});
  res.json({ok:true,documento:data,aviso:'Se versao mudou, usuários precisarão aceitar novamente.'});
});

// ══════════ HEALTH CHECK ══════════════════════════════════════
app.get('/', (req,res) => res.json({
  produto:'🌾 AgroVenda Pro AI v6.0',
  slogan:'Seu copiloto para vender melhor. A IA organiza os dados para você decidir com mais segurança.',
  versao:'7.0.0',
  infraestrutura:[
    'dados_mercado_historico — série temporal real (CEPEA/BCB/Yahoo)',
    'sinais_ia — motor de sinal auditável com versão do algoritmo',
    'resultados_sinais — backtesting automático via trigger SQL',
    'log_coletas — rastreabilidade de cada coleta por fonte',
    'fontes_dados — catálogo com status e taxa de sucesso',
    'ml_configuracao — features e hiperparâmetros do LightGBM',
    'exportar_features_ml() — SQL pronto para pipeline Python',
    'accuracy_modelo() — métrica real do modelo em produção',
  ],
  endpoints_novos:[
    'GET /dados/historico/:cultura — série histórica real',
    'GET /dados/ultimo/:cultura — último dado por cultura',
    'GET /dados/qualidade — status de cada fonte',
    'GET /sinais/:cultura — histórico de sinais IA',
    'GET /backtesting/:cultura — resultados reais',
    'POST /admin/coleta/executar — trigger manual de coleta',
    'POST /admin/backtesting/avaliar — trigger manual backtesting',
    'POST /admin/backfill — migrar dados históricos',
    'GET /admin/ml/features/:cultura — exportar para Python/LightGBM',
    'GET /admin/ml/accuracy/:cultura — accuracy real do modelo',
  ],
  timestamp:new Date().toISOString()
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🌾 AgroVenda Pro AI v6.0 — porta ${PORT}`);
  console.log('   Infraestrutura de dados real ativa');
  iniciarAutomacao(supabase, process.env.ANTHROPIC_API_KEY);
});
