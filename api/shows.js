const BASE = process.env.KOPIS_BASE || "http://www.kopis.or.kr/openApi/restful";
const KEY = process.env.KOPIS_KEY;
const MUSICAL_MIN_SEATS = 1000; // 뮤지컬은 이 좌석 수 이상만
const REGIONS = ["서울", "경기"]; // 이 지역 공연장만
const AREA_CODES = ["11", "41"]; // 뮤지컬 예매상황판 지역 코드 (서울 11, 경기 41)
const PAGE_ROWS = 30;
// 트로트 판별용 단어 (공연명이나 출연진에 들어 있으면 트로트로 봄). 자유롭게 추가하세요.
const TROT_WORDS = ["트로트", "트롯", "가요무대", "효콘서트", "임영웅", "송가인", "영탁", "이찬원", "장민호", "정동원",
  "김호중", "김희재", "양지은", "홍지윤", "김다현", "전유진", "박서진", "손태진", "안성훈", "진해성", "장윤정",
  "홍진영", "진성", "나훈아", "남진", "설운도", "태진아", "주현미", "김연자", "조항조", "박현빈", "김용빈", "박지현"];
const isTrot = (it) => TROT_WORDS.some((w) => (it.name + " " + (it.cast || "")).includes(w));
const CONCURRENCY = 2;
const GAP_MS = 200; // KOPIS 호출 사이 최소 간격
const TIME_BUDGET = 7000;
const cache = new Map();
let lastCall = 0;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
  return m ? decode(m[1]) : "";
}
function blocks(xml, name) {
  return xml.match(new RegExp("<" + name + ">[\\s\\S]*?</" + name + ">", "g")) || [];
}
const one = (v) => (Array.isArray(v) ? v[0] : v || "");
const num = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10) || 0;

function friendly(name, url) {
  const u = (url || "").toLowerCase();
  if (u.includes("interpark.com") || name === "놀유니버스") return "인터파크 티켓(NOL)";
  if (u.includes("ticketlink.co.kr")) return "티켓링크";
  if (u.includes("yes24.com")) return "예스24 티켓";
  if (u.includes("melon.com")) return "멜론티켓";
  return name;
}

async function kopis(path, params) {
  const url = new URL(BASE + path);
  url.searchParams.set("service", KEY);
  for (const k in params) if (params[k]) url.searchParams.set(k, params[k]);
  for (let t = 0; ; t++) {
    const now = Date.now();
    const wait = Math.max(0, lastCall + GAP_MS - now);
    lastCall = now + wait;
    if (wait) await sleep(wait);
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (r.ok) return r.text();
    const body = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 80);
    if (t >= 1) throw new Error("HTTP " + r.status + " " + body);
    await sleep(1500);
  }
}
function cached(key, fn) {
  if (cache.has(key)) return cache.get(key);
  const p = fn();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}
function getDetail(id) {
  return cached("d:" + id, async () => {
    const x = await kopis("/pblprfr/" + encodeURIComponent(id), {});
    const seen = {};
    const relates = blocks(x, "relate")
      .map((r) => {
        const url = tag(r, "relateurl");
        return { name: friendly(tag(r, "relatenm"), url), url };
      })
      .filter((r) => r.name && !seen[r.name] && (seen[r.name] = true));
    return { relates, venue: tag(x, "fcltynm"), mt10id: tag(x, "mt10id"), cast: tag(x, "prfcast") };
  });
}
function getFacility(mt10id) {
  return cached("f:" + mt10id, async () => {
    const x = await kopis("/prfplc/" + encodeURIComponent(mt10id), {});
    const top = x.replace(/<mt13s>[\s\S]*?<\/mt13s>/, "");
    return {
      total: num(tag(top, "seatscale")),
      halls: blocks(x, "mt13").map((h) => ({ name: tag(h, "prfplcnm"), seats: num(tag(h, "seatscale")) })),
    };
  });
}
const ymd8 = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const toNum = (s) => s.replace(/\D/g, "");
// 예매상황판(인기 순위)에서 지역·장르별로 가져오기. 뮤지컬은 1,000석 이상만
async function boxoffice(area, cate) {
  const y = new Date(Date.now() + 9 * 3600e3 - 864e5);
  const ed = ymd8(y);
  const sd = ymd8(new Date(y.getTime() - 29 * 864e5));
  const x = await kopis("/boxoffice", {
    ststype: "month", date: ed, stdate: sd, eddate: ed,
    catecode: cate, area, srchseatscale: cate === "GGGA" ? String(MUSICAL_MIN_SEATS) : "",
  });
  return blocks(x, "boxof").map((b) => {
    const pd = tag(b, "prfpd").split("~");
    let poster = tag(b, "poster");
    if (poster.startsWith("/")) poster = "http://www.kopis.or.kr" + poster;
    return {
      id: tag(b, "mt20id"), name: tag(b, "prfnm"), rank: num(tag(b, "rnum")) || 999,
      start: (pd[0] || "").trim(), end: (pd[1] || "").trim(),
      venue: tag(b, "prfplcnm"), area: tag(b, "area"), poster,
      genre: tag(b, "cate"), state: "", relates: [],
    };
  });
}

function hallSeats(fac, venue) {
  if (fac.halls.length === 0) return fac.total;
  if (fac.halls.length === 1) return fac.halls[0].seats || fac.total;
  const m = venue.match(/\(([^()]+)\)\s*$/);
  const hall = m ? m[1].trim() : "";
  if (!hall) return 0;
  const h = fac.halls.find((x) => x.name === hall || x.name.includes(hall) || hall.includes(x.name));
  return h ? h.seats : 0;
}

module.exports = async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "서버에 KOPIS_KEY 환경변수가 설정되지 않았어요." });
    const genre = String(one(req.query.genre));
    const q = String(one(req.query.q)).slice(0, 30);
    const from = String(one(req.query.from));
    const to = String(one(req.query.to));
    const page = Math.min(Math.max(parseInt(one(req.query.page), 10) || 1, 1), 30);
    const offset = Math.max(parseInt(one(req.query.offset), 10) || 0, 0);
    const mode = String(one(req.query.mode));
    const trot = String(one(req.query.tag)) === "trot";
    const nameQ = trot ? "" : q;

    if (genre && !/^[A-Z]{4}$/.test(genre)) return res.status(400).json({ error: "장르 코드 형식이 올바르지 않아요." });
    if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) return res.status(400).json({ error: "날짜는 YYYYMMDD 형식이어야 해요." });

    const start = Date.now();
    const popular = mode !== "upcoming";
    let all, regional;
    if (popular) {
      const lists = await cached("b:" + genre + ":" + new Date().toISOString().slice(0, 10), async () => {
        const out = [];
        for (const a of AREA_CODES) out.push(...(await boxoffice(a, genre)));
        return out.sort((p, r) => p.rank - r.rank);
      });
      const seenId = {};
      all = lists.filter((x) => x.id && !seenId[x.id] && (seenId[x.id] = true));
      regional = all
        .map((x) => Object.assign({}, x, { relates: [] }))
        .filter((x) => toNum(x.end) >= from && toNum(x.start) <= to && (!nameQ || x.name.includes(nameQ)));
    } else {
      const xml = await cached("l:" + [from, to, genre, nameQ, page].join("|"), () =>
        kopis("/pblprfr", { stdate: from, eddate: to, cpage: String(page), rows: String(PAGE_ROWS), shcate: genre, shprfnm: nameQ, prfstate: "01" })
      );
      all = blocks(xml, "db").map((b) => ({
        id: tag(b, "mt20id"),
        name: tag(b, "prfnm"),
        start: tag(b, "prfpdfrom"),
        end: tag(b, "prfpdto"),
        venue: tag(b, "fcltynm"),
        area: tag(b, "area"),
        poster: tag(b, "poster"),
        genre: tag(b, "genrenm"),
        state: tag(b, "prfstate"),
        relates: [],
      }));
      regional = all.filter((it) => REGIONS.some((r) => it.area.includes(r)));
    }

    const err = { detailFailed: 0, facilityFailed: 0, lastError: "" };
    let i = offset;
    async function worker() {
      while (i < regional.length && Date.now() - start < TIME_BUDGET) {
        const it = regional[i++];
        try {
          const d = await getDetail(it.id);
          it.relates = d.relates;
          it.cast = d.cast;
          if (d.venue) it.venue = d.venue;
          if (!popular && it.genre === "뮤지컬" && d.mt10id) {
            try {
              it.seats = hallSeats(await getFacility(d.mt10id), d.venue);
            } catch (e) {
              err.facilityFailed++;
              err.lastError = e.message;
            }
          }
          it.checked = true;
        } catch (e) {
          err.detailFailed++;
          err.lastError = e.message;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const done = regional.slice(offset, i);
    const shown = done.filter(
      (it) =>
        it.checked &&
        (!trot || isTrot(it)) &&
        (popular ? it.relates.length > 0 : it.genre !== "뮤지컬" || (it.seats || 0) >= MUSICAL_MIN_SEATS)
    );
    let next = null;
    if (i < regional.length) next = { page, offset: i };
    else if (!popular && all.length >= PAGE_ROWS) next = { page: page + 1, offset: 0 };

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=86400");
    res.status(200).json({
      items: shown,
      next,
      stats: {
        mode: popular ? "popular" : "upcoming",
        page,
        listed: all.length,
        regional: regional.length,
        processed: done.length,
        areas: [...new Set(all.map((x) => x.area))].slice(0, 6),
        ...err,
      },
    });
  } catch (e) {
    res.status(502).json({ error: "KOPIS 조회에 실패했어요. 잠시 뒤 다시 시도해 주세요." });
  }
};
