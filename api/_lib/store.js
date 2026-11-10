// 찜 동기화·알림 구독을 담아 두는 저장소 (Upstash Redis REST API)
// Vercel Marketplace에서 Upstash Redis(또는 예전 Vercel KV)를 연결하면 아래 환경변수가 자동으로 생겨요.
const crypto = require("crypto");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEEP_SEC = 400 * 86400; // 400일 동안 안 쓰면 자동 삭제
const MAX_FAVS = 300;
const REMOVED_KEEP_MS = 90 * 864e5;

const enabled = () => !!(URL_ && TOKEN);

async function cmd(...args) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("store " + r.status + " " + (j.error || ""));
  return j.result;
}
async function getJSON(key) {
  const v = await cmd("GET", key);
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch (e) {
    return null;
  }
}
const setJSON = (key, value) => cmd("SET", key, JSON.stringify(value), "EX", String(KEEP_SEC));

// 동기화 코드: 헷갈리는 글자(0, O, 1, I)를 뺀 32글자 중 12글자 (예: K7QF-2MXP-9TZA)
const ALPHA = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function newCode() {
  const b = crypto.randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHA[b[i] % 32];
  return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8);
}
function normCode(c) {
  const s = String(c || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!/^[2-9A-HJ-NP-Z]{12}$/.test(s)) return null;
  return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8);
}

// ---- 찜 목록 ----
// data = { favs: { 공연ID: { ...공연 정보, t: 찜한 시각, u: 정보 갱신 시각 } }, removed: { 공연ID: 찜 해제 시각 } }
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const ts = (v) => (Number.isFinite(+v) && +v > 0 ? Math.min(+v, Date.now() + 864e5) : 0);
const price = (v) => (v === null || v === undefined || !Number.isFinite(+v) ? null : +v);
function cleanItem(id, x) {
  if (!x || typeof x !== "object") return null;
  return {
    id,
    name: str(x.name, 200),
    start: str(x.start, 20),
    end: str(x.end, 20),
    venue: str(x.venue, 200),
    area: str(x.area, 40),
    poster: /^https?:\/\//i.test(x.poster || "") ? str(x.poster, 500) : "",
    genre: str(x.genre, 40),
    relates: (Array.isArray(x.relates) ? x.relates : [])
      .filter((r) => r && /^https?:\/\//i.test(r.url || ""))
      .slice(0, 10)
      .map((r) => ({ name: str(r.name, 60), url: str(r.url, 500) })),
    minPrice: price(x.minPrice),
    maxPrice: price(x.maxPrice),
    t: ts(x.t),
    u: ts(x.u),
    opened: ts(x.opened),
  };
}
const validId = (id) => /^[A-Za-z0-9_-]{1,20}$/.test(id);
function clean(data) {
  const out = { favs: {}, removed: {} };
  const d = data && typeof data === "object" ? data : {};
  for (const id of Object.keys(d.favs || {}).slice(0, MAX_FAVS * 2)) {
    const it = validId(id) && cleanItem(id, d.favs[id]);
    if (it) out.favs[id] = it;
  }
  for (const id of Object.keys(d.removed || {}).slice(0, 2000)) if (validId(id)) out.removed[id] = ts(d.removed[id]);
  return out;
}
// 두 기기의 찜 목록 합치기: 더 나중에 한 동작(찜/해제)이 이겨요. 공연 정보는 더 최근에 갱신된 쪽을 써요.
function merge(a, b) {
  const favs = {};
  const removed = {};
  for (const src of [a, b]) {
    for (const id in src.removed) removed[id] = Math.max(removed[id] || 0, src.removed[id]);
    for (const id in src.favs) {
      const it = src.favs[id];
      const cur = favs[id];
      if (!cur) favs[id] = it;
      else {
        const newer = (it.u || 0) > (cur.u || 0) ? it : cur;
        favs[id] = Object.assign({}, newer, {
          t: Math.max(it.t || 0, cur.t || 0),
          opened: Math.max(it.opened || 0, cur.opened || 0),
        });
      }
    }
  }
  for (const id in favs) {
    if (removed[id] !== undefined && removed[id] >= (favs[id].t || 0)) delete favs[id];
    else delete removed[id];
  }
  const now = Date.now();
  for (const id in removed) if (now - removed[id] > REMOVED_KEEP_MS) delete removed[id];
  const ids = Object.keys(favs).sort((p, q) => favs[q].t - favs[p].t);
  for (const id of ids.slice(MAX_FAVS)) delete favs[id];
  return { favs, removed };
}
const getFavs = (code) => getJSON("fav:" + code);
const saveFavs = (code, data) => setJSON("fav:" + code, data);

// ---- 알림 구독 ----
const getSubs = async (code) => (await getJSON("subs:" + code)) || [];
async function saveSubs(code, subs) {
  if (subs.length) {
    await setJSON("subs:" + code, subs);
    await cmd("SADD", "pushcodes", code);
  } else {
    await cmd("DEL", "subs:" + code);
    await cmd("SREM", "pushcodes", code);
  }
}
const pushCodes = async () => (await cmd("SMEMBERS", "pushcodes")) || [];
const getSent = async (code) => (await getJSON("sent:" + code)) || {};
const saveSent = (code, sent) => setJSON("sent:" + code, sent);

// Vercel은 JSON 본문을 req.body로 넘겨 주지만, 문자열로 올 때도 대비해요.
function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch (e) {
    return {};
  }
}

module.exports = {
  enabled, newCode, normCode, clean, merge, getFavs, saveFavs, getSubs, saveSubs, pushCodes, getSent, saveSent, body,
};
