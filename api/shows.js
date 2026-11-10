const BASE = process.env.KOPIS_BASE || "http://www.kopis.or.kr/openApi/restful";
const KEY = process.env.KOPIS_KEY;
const DETAIL_LIMIT = 24;

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

async function kopis(path, params) {
  const url = new URL(BASE + path);
  url.searchParams.set("service", KEY);
  for (const k in params) if (params[k]) url.searchParams.set(k, params[k]);
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("upstream " + r.status);
  return r.text();
}

module.exports = async (req, res) => {
  try {
    if (!KEY) {
      return res.status(500).json({ error: "서버에 KOPIS_KEY 환경변수가 설정되지 않았어요." });
    }
    const genre = String(one(req.query.genre));
    const q = String(one(req.query.q)).slice(0, 30);
    const from = String(one(req.query.from));
    const to = String(one(req.query.to));
    const rows = Math.min(Math.max(parseInt(one(req.query.rows), 10) || 60, 1), 100);

    if (genre && !/^[A-Z]{4}$/.test(genre)) return res.status(400).json({ error: "장르 코드 형식이 올바르지 않아요." });
    if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) return res.status(400).json({ error: "날짜는 YYYYMMDD 형식이어야 해요." });

    const xml = await kopis("/pblprfr", {
      stdate: from,
      eddate: to,
      cpage: "1",
      rows: String(rows),
      shcate: genre,
      shprfnm: q,
    });

    const items = blocks(xml, "db").map((b) => ({
      id: tag(b, "mt20id"),
      name: tag(b, "prfnm"),
      start: tag(b, "prfpdfrom"),
      end: tag(b, "prfpdto"),
      venue: tag(b, "fcltynm"),
      poster: tag(b, "poster"),
      genre: tag(b, "genrenm"),
      state: tag(b, "prfstate"),
      relates: [],
    }));

    await Promise.all(
      items.slice(0, DETAIL_LIMIT).map(async (it) => {
        try {
          const dx = await kopis("/pblprfr/" + encodeURIComponent(it.id), {});
          it.relates = blocks(dx, "relate")
            .map((r) => ({ name: tag(r, "relatenm"), url: tag(r, "relateurl") }))
            .filter((r) => r.name);
        } catch (e) {}
      })
    );

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ items, detailLimit: DETAIL_LIMIT });
  } catch (e) {
    res.status(502).json({ error: "KOPIS 조회에 실패했어요. 잠시 뒤 다시 시도해 주세요." });
  }
};
