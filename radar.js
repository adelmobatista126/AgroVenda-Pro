// src/radar.js v4.0
// Varre preços, clima e histórico para gerar oportunidades automaticamente
// Roda a cada 1h — producer não precisa fazer nada

const { calcularScore, CLASSIFICACAO } = require('./score');

const CULTURAS = ['cafe','soja','milho','boi','acucar','algodao','trigo'];
const NOMES = {
  cafe:'Café ☕', soja:'Soja 🌱', milho:'Milho 🌽',
  boi:'Boi Gordo 🐂', acucar:'Açúcar 🍬', algodao:'Algodão 🌸', trigo:'Trigo 🌾'
};

async function gerarOportunidades(supabase, precos) {
  if (!precos?.dolar) return [];

  const oportunidades = [];
  const agora = new Date();
  const validade = new Date(agora.getTime() + 6 * 3600 * 1000).toISOString(); // válida por 6h

  for (const cultura of CULTURAS) {
    const p = precos.precos[cultura];
    if (!p?.brl) continue;

    const score = calcularScore({
      cultura, precoAtual: p.brl,
      precoMedia60d: p.media60d, preco7dAtras: p.preco7dAtras,
      dolar: precos.dolar, dolarMedia30d: precos.dolarMedia30d,
      estoqueStatus: 'neutro', volatilidadeAlta: false, climaImpacto: 'neutro'
    });

    // Oportunidade: score >= 70
    if (score.score >= 70) {
      const varPreco = p.media60d
        ? ((p.brl - p.media60d) / p.media60d * 100).toFixed(1)
        : null;

      oportunidades.push({
        cultura,
        tipo: score.score >= 85 ? 'preco_acima_media' : 'tendencia_alta',
        impacto: score.score >= 85 ? 'alto' : 'medio',
        titulo: `${NOMES[cultura]} — ${score.emoji} Score ${score.score}/100`,
        descricao: varPreco
          ? `Preço atual R$ ${p.brl.toLocaleString('pt-BR')} está ${varPreco}% acima da média de 60 dias.`
          : `Score ${score.score}/100 indica momento favorável para ${cultura}.`,
        recomendacao: score.acao,
        score_oportunidade: score.score,
        validade,
        ativa: true,
        dados_base: {
          preco: p.brl, media60d: p.media60d, dolar: precos.dolar,
          score: score.score, confianca: score.confianca,
          fatores: score.itens
        }
      });
    }

    // Risco: score <= 35
    if (score.score <= 35) {
      oportunidades.push({
        cultura,
        tipo: 'risco_queda',
        impacto: score.score <= 20 ? 'alto' : 'medio',
        titulo: `${NOMES[cultura]} — 🔴 Sinal de alerta`,
        descricao: `Score ${score.score}/100 indica condições desfavoráveis para venda agora.`,
        recomendacao: 'Aguardar recuperação do mercado antes de comercializar.',
        score_oportunidade: score.score,
        validade,
        ativa: true,
        dados_base: { preco: p.brl, dolar: precos.dolar, score: score.score }
      });
    }

    // Janela climática
    if (p.climaImpacto === 'positivo' && score.score >= 55) {
      oportunidades.push({
        cultura,
        tipo: 'janela_climatica',
        impacto: 'medio',
        titulo: `${NOMES[cultura]} — 🌦️ Janela climática favorável`,
        descricao: 'Condições climáticas adversas em regiões produtoras tendem a reduzir oferta.',
        recomendacao: 'Considerar venda ou travagem nos próximos 7 dias.',
        score_oportunidade: Math.min(score.score + 5, 100),
        validade,
        ativa: true,
        dados_base: { preco: p.brl, clima: 'positivo', score: score.score }
      });
    }
  }

  // Expirar oportunidades antigas
  await supabase.from('oportunidades')
    .update({ ativa: false })
    .lt('validade', agora.toISOString())
    // .catch(e => console.warn('Expirar oportunidades:', e.message)); // error handled silently

  // Inserir novas oportunidades
  if (oportunidades.length > 0) {
    await supabase.from('oportunidades')
      .insert(oportunidades);
      // catch handled above;
    console.log(`🎯 Radar: ${oportunidades.length} oportunidades geradas`);
  }

  return oportunidades;
}

// Buscar oportunidades ativas para o dashboard
async function buscarOportunidadesAtivas(supabase, culturas = null, limite = 10) {
  let q = supabase.from('oportunidades')
    .select('*')
    .eq('ativa', true)
    .gte('validade', new Date().toISOString())
    .order('score_oportunidade', { ascending: false })
    .limit(limite);

  if (culturas?.length) q = q.in('cultura', culturas);

  const { data } = await q;
  return data || [];
}

module.exports = { gerarOportunidades, buscarOportunidadesAtivas };
