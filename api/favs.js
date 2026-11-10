// 찜 목록 동기화
// POST { action: "create", data }        → 새 동기화 코드를 만들고 찜 목록을 저장해요.
// POST { action: "sync", code, data }    → 서버에 있는 찜 목록과 합쳐서 돌려줘요.
const S = require("./_lib/store");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST로 요청해 주세요." });
  if (!S.enabled()) return res.status(503).json({ error: "서버에 동기화 저장소(Upstash Redis)가 설정되지 않았어요." });
  try {
    const b = S.body(req);
    const data = S.clean(b.data);
    if (b.action === "create") {
      const code = S.newCode();
      const merged = S.merge({ favs: {}, removed: {} }, data);
      await S.saveFavs(code, merged);
      return res.status(200).json({ code, data: merged });
    }
    if (b.action === "sync") {
      const code = S.normCode(b.code);
      if (!code) return res.status(400).json({ error: "동기화 코드 형식이 올바르지 않아요." });
      const saved = await S.getFavs(code);
      if (!saved) return res.status(404).json({ error: "이 동기화 코드를 찾지 못했어요." });
      const merged = S.merge(S.clean(saved), data);
      await S.saveFavs(code, merged);
      return res.status(200).json({ code, data: merged });
    }
    res.status(400).json({ error: "알 수 없는 요청이에요." });
  } catch (e) {
    res.status(502).json({ error: "동기화 저장소에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요." });
  }
};
