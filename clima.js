// src/clima.js v3.3
// Previsão climática via Open-Meteo (gratuito, sem API key)
// Impacto do clima nas cotações de café, soja, milho e boi

const fetch = require('node-fetch');

// Coordenadas dos principais estados produtores
const REGIOES = {
  MT: { lat: -12.64, lon: -55.42, nome: 'Mato Grosso' },
  PR: { lat: -24.89, lon: -51.55, nome: 'Paraná' },
  MG: { lat: -18.51, lon: -44.56, nome: 'Minas Gerais' },
  GO: { lat: -15.82, lon: -49.83, nome: 'Goiás' },
  MS: { lat: -20.77, lon: -54.78, nome: 'Mato Grosso do Sul' },
  SP: { lat: -22.25, lon: -48.05, nome: 'São Paulo' },
  BA: { lat: -12.10, lon: -41.76, nome: 'Bahia' },
  RS: { lat: -29.68, lon: -53.80, nome: 'Rio Grande do Sul' },
};

// Regras de impacto climático por cultura
// Seca = pressão de alta nos preços; excesso de chuva = qualidade ruim
function calcularImpacto(cultura, precipitacao, temp_max) {
  const seco = precipitacao < 2;
  const chuvoso = precipitacao > 15;
  const calor = temp_max > 35;

  const impactos = {
    cafe: seco ? 'positivo' : chuvoso ? 'negativo' : 'neutro', // seca reduz oferta → preço sobe
    soja: seco ? 'positivo' : chuvoso ? 'neutro' : 'neutro',
    milho: seco && calor ? 'positivo' : 'neutro',
    boi: seco ? 'negativo' : 'neutro', // seca reduz pastagem → produtor vende antecipado → preço cai
    algodao: chuvoso ? 'negativo' : 'neutro',
    trigo: seco ? 'positivo' : chuvoso ? 'negativo' : 'neutro',
  };

  return impactos[cultura] || 'neutro';
}

// Buscar previsão 15 dias — Open-Meteo (gratuito, sem API key)
async function buscarPrevisaoClima(estado = 'MT', diasFuturo = 15) {
  const regiao = REGIOES[estado.toUpperCase()] || REGIOES.MT;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?` +
      `latitude=${regiao.lat}&longitude=${regiao.lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
      `&timezone=America/Sao_Paulo&forecast_days=${diasFuturo}`;

    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = await res.json();

    if (!data?.daily?.time) throw new Error('Formato inesperado');

    const previsoes = data.daily.time.map((data_str, i) => ({
      data: data_str,
      temp_min: Math.round(data.daily.temperature_2m_min[i] * 10) / 10,
      temp_max: Math.round(data.daily.temperature_2m_max[i] * 10) / 10,
      chuva_mm: Math.round((data.daily.precipitation_sum[i] || 0) * 10) / 10,
      condicao: data.daily.precipitation_sum[i] > 10 ? 'chuva'
               : data.daily.precipitation_sum[i] < 2 ? 'seco' : 'normal',
    }));

    return {
      estado, regiao: regiao.nome,
      previsoes,
      resumo: gerarResumoClima(previsoes),
      fonte: 'Open-Meteo'
    };
  } catch (e) {
    console.warn(`Clima ${estado}:`, e.message);
    return null;
  }
}

function gerarResumoClima(previsoes) {
  const chuva7d = previsoes.slice(0, 7).reduce((s, d) => s + d.chuva_mm, 0);
  const tempMax = Math.max(...previsoes.slice(0, 7).map(d => d.temp_max));

  if (chuva7d < 10) return `Seca: apenas ${chuva7d.toFixed(0)}mm nos próximos 7 dias. Alerta para lavouras.`;
  if (chuva7d > 80) return `Excesso de chuva: ${chuva7d.toFixed(0)}mm nos próximos 7 dias.`;
  if (tempMax > 38) return `Calor extremo: até ${tempMax}°C. Risco para grãos em desenvolvimento.`;
  return `Clima normal: ${chuva7d.toFixed(0)}mm / 7 dias, máx ${tempMax}°C.`;
}

// Salvar previsão no banco e calcular impacto por cultura
async function salvarPrevisaoClima(supabase, estado) {
  const dados = await buscarPrevisaoClima(estado);
  if (!dados) return null;

  const culturasPorEstado = {
    MT: ['soja', 'milho', 'algodao', 'boi'],
    PR: ['soja', 'milho', 'trigo'],
    MG: ['cafe', 'soja', 'milho'],
    GO: ['soja', 'milho', 'boi'],
    MS: ['soja', 'milho', 'boi'],
    SP: ['cafe', 'acucar', 'boi'],
    BA: ['cafe', 'algodao', 'soja'],
    RS: ['soja', 'milho', 'trigo'],
  };

  const culturas = culturasPorEstado[estado.toUpperCase()] || ['soja', 'milho'];

  const registros = [];
  for (const prev of dados.previsoes) {
    for (const cultura of culturas) {
      registros.push({
        regiao: estado,
        cultura,
        data_previsao: prev.data,
        temperatura_min: prev.temp_min,
        temperatura_max: prev.temp_max,
        precipitacao_mm: prev.chuva_mm,
        condicao: prev.condicao,
        impacto_preco: calcularImpacto(cultura, prev.chuva_mm, prev.temp_max),
        fonte: 'Open-Meteo'
      });
    }
  }

  if (registros.length > 0) {
    await (async()=>{try{return await supabase.from('clima_previsao').upsert(registros,
      { onConflict: 'regiao,data_previsao,cultura' });}catch(e){console.warn('Clima upsert:', e.message)}})().then(null, ()=>{});
  }

  return { ...dados, culturas, registros: registros.length };
}

// Atualizar clima de todos os estados principais
async function atualizarTodosEstados(supabase) {
  const estados = Object.keys(REGIOES);
  for (const estado of estados) {
    await salvarPrevisaoClima(supabase, estado);
    await new Promise(r => setTimeout(r, 500)); // evitar rate limit
  }
  console.log(`🌦️ Clima atualizado: ${estados.length} estados`);
}

module.exports = { buscarPrevisaoClima, salvarPrevisaoClima, atualizarTodosEstados, calcularImpacto };
