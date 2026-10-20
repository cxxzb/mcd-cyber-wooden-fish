/*
 * 麦门功德+1 · 赛博木鱼 - 后端代理
 * 职责：转发并缓存麦当劳官方 MCP（https://mcp.mcd.cn）的真实数据，供前端页面使用。
 * 安全：MCP Token 只从环境变量 MCD_MCP_TOKEN 读取，绝不写入代码。
 * 运行：MCD_MCP_TOKEN=你的token node server.js（无需任何 npm 依赖）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const TOKEN = process.env.MCD_MCP_TOKEN || '';
const MCP_URL = 'https://mcp.mcd.cn';
const ROOT = __dirname;

/* ---------- MCP 调用 ---------- */
function callTool(name, args = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
      params: { name, arguments: args }
    });
    const req = https.request(MCP_URL, {
      method: 'POST', timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          let text = body;
          if (body.includes('data:')) { // SSE 兼容
            const lines = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('data:'));
            if (lines.length) text = lines[lines.length - 1].slice(5).trim();
          }
          const json = JSON.parse(text);
          if (json.result && json.result.content && json.result.content[0]) {
            resolve(json.result.content[0].text);
          } else { resolve(text); }
        } catch (e) { reject(new Error('MCP 响应解析失败: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('MCP 请求超时')));
    req.write(payload);
    req.end();
  });
}

/* MCP 返回是 "markdown 说明 + 内嵌 JSON"，提取其中的 data 字段 */
function extractData(text) {
  const start = text.indexOf('{"success"');
  if (start === -1) return text;
  const end = text.lastIndexOf('}');
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    return typeof j.data === 'string' ? j.data : JSON.stringify(j.data);
  } catch (e) { return text; }
}

/* 解析营养列表：每行 "  名称,null,千焦,千卡,..." */
function parseFoods(text) {
  const foods = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^\s{][^,]*?)\s*,null\s*,\d+\s*,(\d+)\s*,/);
    if (m && m[1] && !/[{}]/.test(m[1])) {
      foods.push({ name: m[1].trim(), kcal: parseInt(m[2], 10) });
    }
  }
  return foods;
}

/* 解析活动日历中的"今日"活动 */
function parseCampaigns(text) {
  const parts = text.split('####');
  const todayPart = parts.find(p => /今日/.test((p.split('\n')[0] || '')));
  const seg = todayPart || parts[1] || text;
  const blocks = seg.split('**活动标题**：').slice(1);
  return blocks.map(b => {
    const title = (b.split('\n')[0] || '').trim();
    const m = b.match(/\*\*活动内容介绍\*\*：([\s\S]*?)(?:\*\*活动图片|$)/);
    let desc = m ? m[1].replace(/<img[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
    if (desc.length > 72) desc = desc.slice(0, 72) + '…';
    return { title, desc };
  }).filter(c => c.title).slice(0, 4);
}

/* 解析服务器时间 */
function parseTime(text) {
  const WEEK = { MONDAY:'星期一', TUESDAY:'星期二', WEDNESDAY:'星期三', THURSDAY:'星期四', FRIDAY:'星期五', SATURDAY:'星期六', SUNDAY:'星期日' };
  try {
    const j = JSON.parse(extractData(text));
    const d = j.data || j;
    return { date: d.date, weekday: WEEK[d.dayOfWeek] || d.dayOfWeek || '', formatted: d.formatted };
  } catch (e) {
    const now = new Date();
    return { date: now.toISOString().slice(0, 10), weekday: '星期' + '日一二三四五六'[now.getDay()], formatted: now.toISOString() };
  }
}

/* 稀有度分档（娱乐向设定，数据本身来自 MCP 真实餐品） */
function rarity(name) {
  if (/新地|麦旋风|圆筒|冰淇淋|圣代|派|雪冰|奶昔|果然/.test(name)) return 'hidden';
  if (/薯条|玉米杯|可乐|零度|咖啡|茶|豆浆|矿泉水|牛奶|汁|酸奶/.test(name)) return 'normal';
  return 'rare';
}

/* ---------- 离线兜底数据池 ----------
 * 当未配置 MCD_MCP_TOKEN 或 MCP 暂时不可达时，用这份内置的真实麦当劳常见餐品兜底，
 * 保证「零配置 clone 下来也能完整玩一遍」。配置了 Token 时永远优先用 MCP 实时数据。 */
const FALLBACK_FOODS = [
  { name: '巨无霸', kcal: 520 }, { name: '麦辣鸡腿堡', kcal: 517 }, { name: '板烧鸡腿堡', kcal: 430 },
  { name: '双层吉士汉堡', kcal: 450 }, { name: '麦香鱼', kcal: 340 }, { name: '培根双层安格斯厚牛堡', kcal: 1003 },
  { name: '双层安格斯厚牛堡', kcal: 987 }, { name: '麦乐鸡5块', kcal: 213 }, { name: '大薯条', kcal: 379 },
  { name: '中薯条', kcal: 289 }, { name: '小薯条', kcal: 210 }, { name: '奥利奥麦旋风', kcal: 266 },
  { name: '原味麦旋风', kcal: 260 }, { name: '原味圆筒冰淇淋', kcal: 93 }, { name: '巧克力新地', kcal: 190 },
  { name: '香草奶昔', kcal: 350 }, { name: '可口可乐(中杯)', kcal: 180 }, { name: '零度可乐(中杯)', kcal: 0 },
  { name: '麦咖啡拿铁', kcal: 130 }, { name: '热奶铁(小杯)', kcal: 134 }, { name: '纯牛奶(盒装)', kcal: 129 },
  { name: '猪柳麦满分', kcal: 308 }, { name: '吉士蛋麦满分', kcal: 300 }, { name: '脆薯饼', kcal: 150 },
  { name: '菠萝派', kcal: 210 }, { name: '香芋派', kcal: 220 }, { name: '玉米杯', kcal: 90 },
  { name: '苹果片', kcal: 45 }
];
const FALLBACK_CAMPAIGNS = [
  { title: '麦门功德日', desc: '离线体验模式 · 敲木鱼攒功德，好运自然来' }
];
/* 本地时间兜底（不依赖 MCP） */
function localTime() {
  const now = new Date();
  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const p = n => String(n).padStart(2, '0');
  return {
    date: now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()),
    weekday: WEEK[now.getDay()],
    formatted: now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) + ' ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds())
  };
}

/* ---------- 缓存 ---------- */
const cache = { foods: null, foodsT: 0, campaigns: null, campaignsT: 0, time: null, timeT: 0 };
const FOOD_TTL_SHORT = 10 * 1000;      // 敲击用：10 秒
const FOOD_TTL_LONG = 10 * 60 * 1000;  // 页面加载用：10 分钟
const CAMP_TTL = 10 * 60 * 1000;
const TIME_TTL = 60 * 1000;

async function getFoods(ttl) {
  if (cache.foods && Date.now() - cache.foodsT < ttl) return cache.foods;
  if (!TOKEN) return FALLBACK_FOODS; // 未配置 Token：直接用兜底，页面照常可玩
  try {
    const text = await callTool('list-nutrition-foods');
    const foods = parseFoods(extractData(text));
    if (!foods.length) throw new Error('餐品池解析为空');
    cache.foods = foods; cache.foodsT = Date.now();
    return foods;
  } catch (e) {
    if (cache.foods) return cache.foods;          // 有旧缓存先用旧的
    console.warn('[fallback] 餐品池使用离线兜底：' + e.message);
    return FALLBACK_FOODS;                          // 否则兜底
  }
}
async function getCampaigns() {
  if (cache.campaigns && Date.now() - cache.campaignsT < CAMP_TTL) return cache.campaigns;
  if (!TOKEN) return FALLBACK_CAMPAIGNS;
  try {
    const text = await callTool('campaign-calendar');
    cache.campaigns = parseCampaigns(text); cache.campaignsT = Date.now();
    return cache.campaigns;
  } catch (e) {
    if (cache.campaigns) return cache.campaigns;
    return FALLBACK_CAMPAIGNS;
  }
}
async function getTime() {
  if (cache.time && Date.now() - cache.timeT < TIME_TTL) return cache.time;
  if (!TOKEN) return localTime();
  try {
    const text = await callTool('now-time-info');
    cache.time = parseTime(text); cache.timeT = Date.now();
    return cache.time;
  } catch (e) {
    if (cache.time) return cache.time;
    return localTime();
  }
}

/* 热销产品加权：巨无霸、薯条、麦旋风这些当家产品更容易显化 */
const HOT = /巨无霸|麦辣|板烧|麦香鱼|吉士|安格斯|双层|薯条|麦乐鸡|麦旋风|圆筒|可乐|麦满分|派|麦咖啡/;
function pick(arr, n) {
  const items = arr.slice();
  const out = [];
  while (out.length < n && items.length) {
    let total = 0;
    const ws = items.map(f => (HOT.test(f.name) ? 4 : 1));
    ws.forEach(w => total += w);
    let r = Math.random() * total, idx = items.length - 1;
    for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r < 0) { idx = i; break; } }
    out.push(items.splice(idx, 1)[0]);
  }
  return out;
}

/* ---------- HTTP 服务 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (url.pathname === '/api/daily') {
      const [time, campaigns, foods] = await Promise.all([getTime(), getCampaigns(), getFoods(FOOD_TTL_LONG)]);
      return res.end(JSON.stringify({
        time, campaigns,
        source: (TOKEN && foods !== FALLBACK_FOODS) ? 'live' : 'fallback',
        pool: foods.map(f => ({ name: f.name, kcal: f.kcal, rarity: rarity(f.name) })),
        limited: campaigns.length ? { name: '当日限定 · ' + campaigns[0].title, rarity: 'limited' } : null
      }));
    }

    if (url.pathname === '/api/knock') {
      const count = Math.min(parseInt(url.searchParams.get('count') || '1', 10) || 1, 3);
      const foods = await getFoods(FOOD_TTL_SHORT);
      const picked = pick(foods, count).map(f => ({ name: f.name, kcal: f.kcal, rarity: rarity(f.name) }));
      let limited = null;
      try {
        const camps = await getCampaigns();
        if (camps.length && Math.random() < 0.08) { // 8% 概率出当日限定
          limited = { name: '当日限定 · ' + camps[0].title, rarity: 'limited' };
        }
      } catch (e) { /* 活动失败不影响敲击 */ }
      const items = limited ? [limited, ...picked.slice(0, count - 1)] : picked;
      return res.end(JSON.stringify({ items }));
    }

    if (url.pathname === '/api/spin') {
      const [foods, campaigns] = await Promise.all([getFoods(FOOD_TTL_LONG), getCampaigns()]);
      const sectors = [];
      for (const f of pick(foods, 6)) sectors.push({ label: f.name, type: rarity(f.name), kcal: f.kcal });
      if (campaigns.length) sectors.push({ label: '当日限定', type: 'limited', desc: campaigns[0].title });
      else sectors.push({ label: '神秘单品', type: 'hidden' });
      sectors.push({ label: '功德翻倍', type: 'bonus' });
      const resultIndex = Math.floor(Math.random() * sectors.length);
      return res.end(JSON.stringify({ sectors, resultIndex }));
    }

    /* 静态文件 */
    let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const full = path.join(ROOT, path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
    if (full.startsWith(ROOT) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.setHeader('Content-Type', MIME[path.extname(full)] || 'application/octet-stream');
      return res.end(fs.readFileSync(full));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log('麦门功德+1 服务已启动: http://localhost:' + PORT));
