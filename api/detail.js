// 공연 상세 정보 (상세 보기 화면, 찜 정보 새로 고침에 사용)
// GET /api/detail?ids=PF1,PF2  (한 번에 최대 20개)
const K = require("./_lib/kopis");

const MAX_IDS = 20;

module.exports = async (req, res) => {
  try {
    if (!K.KEY) return res.status(500).json({ error: "서버에 KOPIS_KEY 환경변수가 설정되지 않았어요." });
    const ids = [...new Set(String(K.one(req.query.ids)).split(",").map((s) => s.trim()).filter(Boolean))];
    if (!ids.length || ids.length > MAX_IDS || ids.some((id) => !/^[A-Za-z0-9_-]{1,20}$/.test(id))) {
      return res.status(400).json({ error: "공연 ID 형식이 올바르지 않아요. (최대 " + MAX_IDS + "개)" });
    }
    const items = {};
    const failed = [];
    let next = 0;
    async function worker() {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          const d = await K.getDetail(id);
          const { mt10id, ...pub } = d;
          items[id] = pub;
        } catch (e) {
          failed.push(id);
        }
      }
    }
    await Promise.all([worker(), worker()]);
    if (!Object.keys(items).length) return res.status(502).json({ error: "공연 정보를 불러오지 못했어요.", failed });
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({ items, failed });
  } catch (e) {
    res.status(502).json({ error: "KOPIS 조회에 실패했어요. 잠시 뒤 다시 시도해 주세요." });
  }
};
